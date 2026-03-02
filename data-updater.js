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
    menus: {
      breakfast: 104745, // Kenilworth Junior High Breakfast 25/26
      lunch:     114014, // 2025-26 Kenilworth Jr. High Lunch
    },
  },
  penngrove: {
    label: 'Elementary',
    calendarUrl: 'https://petalumacityschools.org/penngrove/our-school/calendars',
    calendarType: 'year-round',
    menus: {
      breakfast: 104333, // Elementary School Breakfast
      lunch:     104335, // Elementary School Lunch
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

  // Fetch current month + next month so parents see upcoming menus
  const now = new Date();
  const months = [0, 1].map(offset => {
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

const MONTH_MAP = {
  january:'01', jan:'01', february:'02', feb:'02', march:'03', mar:'03',
  april:'04',   apr:'04', may:'05',       june:'06', jun:'06', july:'07',
  jul:'07',     august:'08', aug:'08', september:'09', sep:'09', sept:'09',
  october:'10', oct:'10', november:'11', nov:'11', december:'12', dec:'12',
};

const NO_SCHOOL_PATTERNS = [
  /no\s+school/i, /school\s+closed/i, /schools?\s+not\s+in\s+session/i,
  /holiday/i, /thanksgiving/i, /christmas/i, /new\s+year/i,
  /martin\s+luther\s+king/i, /mlk\s+day/i, /presidents?\s*day/i,
  /memorial\s+day/i, /labor\s+day/i, /veterans?\s+day/i, /independence\s+day/i,
  /winter\s+break/i, /spring\s+break/i, /summer\s+break/i,
  /thanksgiving\s+break/i, /holiday\s+break/i,
  /professional\s+development/i, /prof\.?\s+dev\.?/i,
  /teacher\s+workday/i, /staff\s+development/i, /inservice/i, /in[-\s]service/i,
  /parent[- ]teacher\s+conference/i, /conferences/i,
  /minimum\s+day/i, /early\s+release/i, /early\s+dismissal/i, /half\s+day/i,
];

function getMonthNum(name) {
  return MONTH_MAP[name.toLowerCase().replace('.', '')] || null;
}

function extractDates(text) {
  const dates = new Set();
  const cur = new Date().getFullYear();
  const next = cur + 1;

  const re1 = /(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const mn = m[0].split(/\s+/)[0].toLowerCase().replace('.', '');
    const mo = getMonthNum(mn);
    if (!mo) continue;
    const day = m[1].padStart(2, '0');
    const yr = m[2] || (['aug','august','sep','sept','september','oct','october','nov','november','dec','december'].includes(mn) ? cur : next);
    dates.add(`${yr}-${mo}-${day}`);
  }

  const re2 = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g;
  while ((m = re2.exec(text)) !== null) {
    dates.add(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
  }

  return [...dates];
}

async function scrapeCalendarForSchool(schoolKey, config) {
  console.log(`\n📅 Fetching calendar for ${config.label} (${schoolKey})...`);

  const pdfEvents = [];
  let pdfLinks = [];

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
    console.log(`   Found ${pdfLinks.length} PDF links`);
  } catch (err) {
    console.warn(`   ⚠️  Could not load calendar page: ${err.message}`);
  }

  for (const pdfUrl of pdfLinks.slice(0, 3)) {
    try {
      const dl = await axios.get(pdfUrl, { responseType: 'arraybuffer', timeout: 60000 });
      const parsed = await pdf(Buffer.from(dl.data));
      const lines = parsed.text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length < 3) continue;
        if (NO_SCHOOL_PATTERNS.some(p => p.test(line))) {
          const ctx = [lines[i-2]||'', lines[i-1]||'', line, lines[i+1]||'', lines[i+2]||''].join(' ');
          extractDates(ctx).forEach(date => pdfEvents.push({ date, title: line, isNoSchool: true }));
        }
      }
      if (pdfEvents.length > 10) break;
    } catch (err) {
      console.warn(`   ⚠️  PDF parse failed: ${err.message}`);
    }
  }

  // Build a full school-year day map (Aug → Jul)
  const yr = new Date().getFullYear();
  const start = new Date(yr, 7, 1);
  const end   = new Date(yr + 1, 6, 31);
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
  for (const ev of pdfEvents) {
    if (ev.date && schoolDays[ev.date]) {
      const dow = new Date(ev.date + 'T12:00:00').getDay();
      if (dow >= 1 && dow <= 5) {
        schoolDays[ev.date].isSchoolDay = false;
        schoolDays[ev.date].status = ev.title.replace(/^\d+\s+/, '').trim();
        schoolDays[ev.date].events.push(ev);
        overrides++;
      }
    }
  }

  console.log(`   ${overrides} no-school overrides applied from PDF`);

  return {
    label: config.label,
    calendarType: config.calendarType,
    schoolDays,
    lastScraped: new Date().toISOString(),
    pdfEventsFound: pdfEvents.length,
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
