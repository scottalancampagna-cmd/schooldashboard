#!/usr/bin/env node
/**
 * data-updater.js
 * Fetches school calendar (PDF) and menus (healthepro) and writes:
 *   - school-data.json  (calendar: school days / no-school events)
 *   - menu-data.json    (menus by date for each school)
 *
 * Run by GitHub Actions daily at 6 AM Pacific.
 */

const fs = require('fs').promises;
const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');

// ─── School configuration ────────────────────────────────────────────────────
const SCHOOLS = {
  kenilworth: {
    label: 'Middle School',
    calendarUrl: 'https://petalumacityschools.org/kenilworth/our-school/calendars',
    calendarType: 'traditional',
    // healthepro site IDs (filled in once network requests are inspected)
    // TODO: open https://menus.healthepro.com/organizations/472 in Chrome DevTools
    //       → Network tab → Fetch/XHR → select school & menu type
    //       → paste the request URLs here
    healtheproSchoolId: null,   // e.g. 123
    healtheproBreakfastId: null, // e.g. 1
    healtheproLunchId: null,     // e.g. 2
  },
  penngrove: {
    label: 'Elementary',
    calendarUrl: 'https://petalumacityschools.org/penngrove/our-school/calendars',
    calendarType: 'year-round',
    healtheproSchoolId: null,
    healtheproBreakfastId: null,
    healtheproLunchId: null,
  }
};

// ─── Calendar scraping ───────────────────────────────────────────────────────

const MONTH_MAP = {
  january:'01', jan:'01', february:'02', feb:'02', march:'03', mar:'03',
  april:'04',   apr:'04', may:'05',       june:'06', jun:'06', july:'07',
  jul:'07',     august:'08', aug:'08', september:'09', sep:'09', sept:'09',
  october:'10', oct:'10', november:'11', nov:'11', december:'12', dec:'12'
};

const NO_SCHOOL_PATTERNS = [
  /no\s+school/i, /school\s+closed/i, /schools?\s+not\s+in\s+session/i,
  /holiday/i, /thanksgiving/i, /christmas/i, /new\s+year/i,
  /martin\s+luther\s+king/i, /mlk\s+day/i, /presidents?\s*day/i,
  /memorial\s+day/i, /labor\s+day/i, /veterans?\s+day/i,
  /independence\s+day/i, /winter\s+break/i, /spring\s+break/i,
  /summer\s+break/i, /thanksgiving\s+break/i, /holiday\s+break/i,
  /professional\s+development/i, /prof\.?\s+dev\.?/i,
  /teacher\s+workday/i, /staff\s+development/i, /inservice/i,
  /in[-\s]service/i, /parent[- ]teacher\s+conference/i, /conferences/i,
  /minimum\s+day/i, /early\s+release/i, /early\s+dismissal/i, /half\s+day/i,
];

function getMonthNum(name) {
  return MONTH_MAP[name.toLowerCase().replace('.', '')] || null;
}

function extractDates(text) {
  const dates = new Set();
  const cur = new Date().getFullYear();
  const next = cur + 1;

  // "January 15" or "January 15, 2026"
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

  // MM/DD/YYYY or MM-DD-YYYY
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

  // Step 1: find PDF links on the school's calendar page
  try {
    const resp = await axios.get(config.calendarUrl, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; school-dashboard/2.0)' }
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

  // Step 2: download & parse PDFs, extract no-school events
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
          const dates = extractDates(ctx);
          if (dates.length) {
            dates.forEach(date => pdfEvents.push({ date, title: line, isNoSchool: true }));
          }
        }
      }
      console.log(`   Parsed PDF: ${pdfEvents.length} events so far`);
      if (pdfEvents.length > 10) break;
    } catch (err) {
      console.warn(`   ⚠️  PDF parse failed: ${err.message}`);
    }
  }

  // Step 3: build a full school-year day map (Aug → Jul)
  const today = new Date();
  const yr = today.getFullYear();
  const start = new Date(yr, 7, 1);   // Aug 1
  const end   = new Date(yr + 1, 6, 31); // Jul 31
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

  // Overlay no-school events from PDF
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

  console.log(`   ${overrides} no-school overrides applied`);

  return {
    label: config.label,
    calendarType: config.calendarType,
    schoolDays,
    lastScraped: new Date().toISOString(),
    pdfEventsFound: pdfEvents.length,
    fallback: pdfLinks.length === 0,
  };
}

// ─── Menu fetching ───────────────────────────────────────────────────────────
// healthepro API endpoints — fill these in once you inspect network requests:
//   1. Open https://menus.healthepro.com/organizations/472 in Chrome
//   2. Open DevTools → Network tab → filter by Fetch/XHR
//   3. Click a school and a menu type (breakfast/lunch)
//   4. Copy the request URLs — they'll look like:
//        /api/menus?school_id=XXX&type=lunch&date=2026-03-01
//      or similar. Paste the full URL pattern below.
//
// Once we know the pattern:
//   - Set SCHOOLS[key].healtheproSchoolId etc. above
//   - Uncomment and fill in fetchMenusForSchool() below

async function fetchMenusForSchool(schoolKey, config, startDate, endDate) {
  if (!config.healtheproSchoolId) {
    console.log(`   ℹ️  ${config.label}: healthepro IDs not configured yet — skipping menu fetch`);
    return {};
  }

  // TODO: replace this URL template with the real endpoint pattern
  // Example placeholder (update after inspecting network requests):
  //   const url = `https://menus.healthepro.com/api/menus?organization_id=472&school_id=${config.healtheproSchoolId}&date=${dateStr}`;
  console.log(`   📋 Fetching menus for ${config.label} from healthepro...`);
  const menus = {};

  // Iterate over each day in range and fetch
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    const dateStr = d.toISOString().split('T')[0];

    // ── Replace the lines below with the real API call ──────────────────────
    // const resp = await axios.get(url, { timeout: 10000 });
    // const data = resp.data;
    // menus[dateStr] = {
    //   breakfast: data.breakfast?.items?.map(i => i.name) || [],
    //   lunch:     data.lunch?.items?.map(i => i.name)     || [],
    // };
    // ────────────────────────────────────────────────────────────────────────
  }

  return menus;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Data Updater starting...');
  const startDate = new Date();
  const endDate   = new Date(startDate);
  endDate.setDate(endDate.getDate() + 30); // fetch menus for next 30 days

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

  const schoolData = {
    lastUpdated: new Date().toISOString(),
    calendars,
    menus: {} // menus are in menu-data.json
  };
  await fs.writeFile('./school-data.json', JSON.stringify(schoolData, null, 2));
  console.log('\n✅ school-data.json written');

  // 2. Menu data
  const menusBySchool = {};
  for (const [key, config] of Object.entries(SCHOOLS)) {
    try {
      menusBySchool[key] = {
        label: config.label,
        menus: await fetchMenusForSchool(key, config, startDate, endDate),
        lastFetched: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`❌ Menu fetch failed for ${key}:`, err.message);
      menusBySchool[key] = { label: config.label, menus: {}, error: err.message };
    }
  }

  const menuData = {
    lastUpdated: new Date().toISOString(),
    schools: menusBySchool,
  };
  await fs.writeFile('./menu-data.json', JSON.stringify(menuData, null, 2));
  console.log('✅ menu-data.json written');

  console.log('\n🎉 Data update complete!');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
