#!/usr/bin/env node
/**
 * data-updater.js
 * Fetches school calendar (PDF scraping) and menus (healthepro API) and writes:
 *   - school-data.json  (calendar: school days / no-school events)
 *   - menu-data.json    (menus by date for each school)
 *
 * Run by GitHub Actions daily at 6 AM PT.
 * Run locally: npm run update-data
 */

const fs = require('fs').promises;
const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');

const ORG_ID = 472;

// ─── School configuration ────────────────────────────────────────────────────
const SCHOOLS = {
  kenilworth: {
    label: 'Middle School',
    calendarUrl: 'https://petalumacityschools.org/kenilworth/our-school/calendars',
    calendarType: 'traditional',
    calendarPdfUrls: [
      'https://d3g27eodky9jlt.cloudfront.net/Calendar-2026-27-Traditional.pdf',
    ],
    menus: {
      breakfast: 104745, // Kenilworth Junior High Breakfast 25/26
      lunch:     114014, // 2025-26 Kenilworth Jr. High Lunch
    },
  },
  penngrove: {
    label: 'Elementary',
    calendarUrl: 'https://petalumacityschools.org/penngrove/our-school/calendars',
    calendarType: 'year-round',
    calendarPdfUrls: [
      'https://d3g27eodky9jlt.cloudfront.net/Calendar-2026-27-Year-Round.pdf',
    ],
    menus: {
      breakfast: 122405, // Penngrove Elementary Breakfast 25/26
      lunch:     122404, // Penngrove Elementary Lunch 25/26
    },
  },
};

// Categories to skip in the menu display (too basic / not useful for planning)
const SKIP_CATEGORIES = new Set(['Milk', 'Condiments', 'Condiment', 'Beverages', 'Beverage']);

// ─── Menu fetching ───────────────────────────────────────────────────────────

/**
 * Fetches menus for a school for the current and next month.
 * Returns an object keyed by date string: { "2026-03-02": { breakfast: [...], lunch: [...] } }
 *
 * API endpoints:
 *   GET /api/organizations/472/menus/{menuId}/year/{year}/month/{month}/date_overwrites
 *   Returns array of day entries, each with a `setting` field (stringified JSON) containing:
 *     - current_display: [{type: "category"|"recipe", name: "..."}, ...]
 *     - days_off: [] (school day) OR {status: 1, description: "..."} (no school)
 */
async function fetchMenusForSchool(schoolKey, config) {
  console.log(`\n🍽️  Fetching menus for ${config.label}...`);

  const result = {};

  // Fetch previous + current + next month so we always have data
  // (districts often publish months late, so prev month is a useful fallback)
  const now = new Date();
  const months = [-1, 0, 1].map(offset => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  for (const [mealType, menuId] of Object.entries(config.menus)) {
    for (const { year, month } of months) {
      const url = `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus/${menuId}/year/${year}/month/${month}/date_overwrites`;

      try {
        const resp = await axios.get(url, { timeout: 15000 });
        // API returns either a raw array or {data: [...]}
        const days = Array.isArray(resp.data) ? resp.data : (resp.data?.data ?? []);

        if (!Array.isArray(days) || days.length === 0) {
          console.log(`   ℹ️  ${mealType} ${year}-${String(month).padStart(2, '0')}: empty response`);
          continue;
        }

        for (const day of days) {
          if (!day.day) continue;

          let setting;
          try {
            setting = typeof day.setting === 'string' ? JSON.parse(day.setting) : day.setting;
          } catch {
            continue;
          }

          if (!result[day.day]) result[day.day] = {};

          // days_off is [] on normal days, {status:1, description:"..."} on no-school days
          const daysOff = setting.days_off;
          const isNoSchool = !Array.isArray(daysOff) && daysOff?.status === 1;

          if (isNoSchool) {
            result[day.day][mealType] = [];
            continue;
          }

          // Walk current_display: track current category, collect recipe names
          let currentCategory = '';
          const items = [];

          for (const entry of (setting.current_display ?? [])) {
            if (entry.type === 'category') {
              currentCategory = entry.name;
            } else if (entry.type === 'recipe' && !SKIP_CATEGORIES.has(currentCategory)) {
              items.push(entry.name);
            }
          }

          result[day.day][mealType] = items;
        }

        console.log(`   ✅ ${mealType} ${year}-${String(month).padStart(2, '0')}: ${days.length} days fetched`);

      } catch (err) {
        if (err.response?.status === 400 || err.response?.status === 404) {
          console.log(`   ℹ️  ${mealType} ${year}-${String(month).padStart(2, '0')}: not published yet`);
        } else {
          console.error(`   ❌ ${mealType} ${year}-${String(month).padStart(2, '0')}: ${err.message}`);
        }
      }
    }
  }

  return result;
}

// ─── Calendar scraping ───────────────────────────────────────────────────────

const MONTH_NUM = {
  january:1, february:2, march:3, april:4, may:5, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12,
};
const MO = Object.keys(MONTH_NUM).join('|');

function expandDateRange(y1, m1, d1, y2, m2, d2) {
  const dates = [];
  for (let d = new Date(y1, m1-1, d1), end = new Date(y2, m2-1, d2); d <= end; d.setDate(d.getDate()+1)) {
    dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  return dates;
}

// Parse a single line and return [] or an array of YYYY-MM-DD dates.
// Handles: "Month DD, YYYY"  "Month DD-DD, YYYY"  "Month DD - DD, YYYY"
//          "Month DD - Month DD, YYYY"  "Month DD, YYYY - Month DD, YYYY"
function parseDateLine(line) {
  const t = line.trim();
  let m;

  // Cross-month range: "Sep 21 - Oct 9, 2026" or "Dec 21, 2026 - Jan 4, 2027"
  const reX = new RegExp(`^(${MO})\\s+(\\d{1,2})(?:,\\s*\\d{4})?\\s*[-–]\\s*(${MO})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`, 'i');
  if ((m = t.match(reX))) {
    const mo1 = MONTH_NUM[m[1].toLowerCase()], d1 = +m[2];
    const mo2 = MONTH_NUM[m[3].toLowerCase()], d2 = +m[4];
    const yr  = m[5] ? +m[5] : new Date().getFullYear() + (mo2 < 6 ? 1 : 0);
    const yr1 = (mo2 < mo1) ? yr - 1 : yr;
    return expandDateRange(yr1, mo1, d1, yr, mo2, d2);
  }

  // Same-month range: "Nov 23 - 27, 2026" or "Feb 17-19, 2027"
  const reS = new RegExp(`^(${MO})\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2}),?\\s*(\\d{4})$`, 'i');
  if ((m = t.match(reS))) {
    const mo = MONTH_NUM[m[1].toLowerCase()], yr = +m[4];
    return expandDateRange(yr, mo, +m[2], yr, mo, +m[3]);
  }

  // Single date: "September 7, 2026"
  const re1 = new RegExp(`^(${MO})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})$`, 'i');
  if ((m = t.match(re1))) {
    const mo = String(MONTH_NUM[m[1].toLowerCase()]).padStart(2,'0');
    return [`${m[3]}-${mo}-${m[2].padStart(2,'0')}`];
  }

  return [];
}

// Extract all no-school dates from PDF text using the "Non-Student Days" section.
// Petaluma City Schools PDFs include bilingual (English + Spanish) versions of the
// calendar. We scan only the English section:
//   start: "Non-Student Days" header
//   end:   "Grading Periods", "Semesters", "Trimesters", "CALENDARIO DE", or "Board Approved"
// This range covers both the Non-Student Days and Teachers' Workdays boxes and
// avoids false positives from grading-period end dates that appear later in the PDF.
function extractNoSchoolDatesFromPdf(text) {
  const lines = text.split('\n');
  const dates = new Set();

  const SECTION_START = /non-student days/i;
  const SECTION_END = /grading periods?|semesters?|trimesters?|calendario de|board approved/i;

  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inSection && SECTION_START.test(l)) { inSection = true; continue; }
    if (inSection && SECTION_END.test(l)) break;
    if (inSection) parseDateLine(l).forEach(d => dates.add(d));
  }

  return [...dates];
}

async function scrapeCalendarForSchool(schoolKey, config) {
  console.log(`\n📅 Fetching calendar for ${config.label} (${schoolKey})...`);

  // Prefer direct PDF URLs from config; fall back to scraping the school webpage
  let pdfLinks = config.calendarPdfUrls ? [...config.calendarPdfUrls] : [];

  if (pdfLinks.length === 0) {
    try {
      const resp = await axios.get(config.calendarUrl, {
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; school-dashboard/2.0)' },
      });
      const $ = cheerio.load(resp.data);
      $('a').each((_, el) => {
        const href = $(el).attr('href');
        if (href && href.toLowerCase().includes('.pdf')) {
          const url = href.startsWith('http') ? href : new URL(href, config.calendarUrl).href;
          pdfLinks.push(url);
        }
      });
      console.log(`   Found ${pdfLinks.length} PDF links on page`);
    } catch (err) {
      console.warn(`   ⚠️  Could not load calendar page: ${err.message}`);
    }
  } else {
    console.log(`   Using ${pdfLinks.length} direct PDF URL(s)`);
  }

  const noSchoolDates = new Set();

  for (const pdfUrl of pdfLinks.slice(0, 3)) {
    try {
      const dl = await axios.get(pdfUrl, { responseType: 'arraybuffer', timeout: 60000 });
      const parsed = await pdf(Buffer.from(dl.data));
      extractNoSchoolDatesFromPdf(parsed.text).forEach(d => noSchoolDates.add(d));
      console.log(`   ✅ Extracted ${noSchoolDates.size} no-school dates from PDF`);
      break; // one PDF is enough
    } catch (err) {
      console.warn(`   ⚠️  PDF parse failed: ${err.message}`);
    }
  }

  // Build a full school-year day map (Jul → Jun, covers year-round starts)
  const yr = new Date().getFullYear();
  const start = new Date(yr, 6, 1);  // July 1 — catches year-round school starts
  const end   = new Date(yr + 1, 5, 30);
  const schoolDays = {};

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().split('T')[0];
    const dow = d.getDay();
    schoolDays[key] = {
      date: key,
      isSchoolDay: dow >= 1 && dow <= 5,
      status: dow >= 1 && dow <= 5 ? 'School Day' : 'Weekend',
      events: [],
    };
  }

  let overrides = 0;
  for (const dateStr of noSchoolDates) {
    if (schoolDays[dateStr]) {
      const dow = new Date(dateStr + 'T12:00:00').getDay();
      if (dow >= 1 && dow <= 5) {
        schoolDays[dateStr].isSchoolDay = false;
        schoolDays[dateStr].status = 'No School';
        overrides++;
      }
    }
  }

  console.log(`   ${overrides} no-school weekday overrides applied`);

  return {
    label: config.label,
    calendarType: config.calendarType,
    schoolDays,
    lastScraped: new Date().toISOString(),
    noSchoolDatesFound: noSchoolDates.size,
    fallback: pdfLinks.length === 0,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Data Updater starting...\n');

  // 1. Calendar data
  const calendars = {};
  for (const [key, config] of Object.entries(SCHOOLS)) {
    try {
      calendars[key] = await scrapeCalendarForSchool(key, config);
    } catch (err) {
      console.error(`❌ Calendar scrape failed for ${key}:`, err.message);
      calendars[key] = { label: config.label, error: err.message, schoolDays: {}, fallback: true };
    }
  }

  await fs.writeFile('./school-data.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    calendars,
    menus: {},
  }, null, 2));
  console.log('\n✅ school-data.json written');

  // 2. Menu data
  const menusBySchool = {};
  for (const [key, config] of Object.entries(SCHOOLS)) {
    try {
      const menus = await fetchMenusForSchool(key, config);
      menusBySchool[key] = {
        label: config.label,
        menus,
        lastFetched: new Date().toISOString(),
      };
      const dayCount = Object.keys(menus).length;
      console.log(`   📋 ${config.label}: ${dayCount} days of menu data`);
    } catch (err) {
      console.error(`❌ Menu fetch failed for ${key}:`, err.message);
      menusBySchool[key] = { label: config.label, menus: {}, error: err.message };
    }
  }

  await fs.writeFile('./menu-data.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    schools: menusBySchool,
  }, null, 2));
  console.log('✅ menu-data.json written');

  console.log('\n🎉 Data update complete!');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
