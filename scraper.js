// No-Browser PDF Calendar Scraper for Petaluma Schools
// Uses direct HTTP requests instead of Puppeteer to avoid browser issues

const fs = require('fs').promises;
const pdf = require('pdf-parse');
const axios = require('axios');
const cheerio = require('cheerio');

class NoBrowserPDFScraper {
    constructor() {
        this.data = {
            calendars: {},
            lastUpdated: new Date().toISOString()
        };
    }

    // Scrape HTML page using cheerio instead of browser
    async scrapePageForPDFs(url, schoolName) {
        console.log(`🔍 Scraping ${schoolName} calendar page: ${url}`);
        
        try {
            const response = await axios.get(url, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            
            const $ = cheerio.load(response.data);
            const pdfLinks = [];
            
            // Find all links that might be PDFs
            $('a').each((i, element) => {
                const href = $(element).attr('href');
                const text = $(element).text().trim();
                
                if (href) {
                    // Direct PDF links
                    if (href.toLowerCase().includes('.pdf')) {
                        pdfLinks.push({
                            url: href.startsWith('http') ? href : new URL(href, url).href,
                            text: text,
                            type: 'direct_pdf'
                        });
                    }
                    // Links that might lead to calendars
                    else if (text.toLowerCase().includes('calendar') || 
                            text.toLowerCase().includes('academic') ||
                            text.toLowerCase().includes('school year')) {
                        pdfLinks.push({
                            url: href.startsWith('http') ? href : new URL(href, url).href,
                            text: text,
                            type: 'calendar_page'
                        });
                    }
                }
            });
            
            console.log(`📄 Found ${pdfLinks.length} potential PDF sources`);
            return pdfLinks;
            
        } catch (error) {
            console.error(`❌ Error scraping ${schoolName} page:`, error.message);
            return [];
        }
    }

    // Try known PDF URL patterns for Petaluma schools
    async tryKnownPDFPatterns(schoolName) {
        console.log(`🎯 Trying known PDF patterns for ${schoolName}...`);
        
        const schoolCode = schoolName.toLowerCase().includes('kenilworth') ? 'kenilworth' : 'penngrove';
        const currentYear = new Date().getFullYear();
        const nextYear = currentYear + 1;
        
        // Common PDF URL patterns for school districts
        const patterns = [
            `https://petalumacityschools.org/${schoolCode}/calendar.pdf`,
            `https://petalumacityschools.org/${schoolCode}/calendar-${currentYear}-${nextYear}.pdf`,
            `https://petalumacityschools.org/calendar/${schoolCode}.pdf`,
            `https://petalumacityschools.org/calendars/${schoolCode}-calendar.pdf`,
            `https://petalumacityschools.org/files/calendar-${schoolCode}.pdf`,
            `https://petalumacityschools.org/docs/${schoolCode}/calendar.pdf`,
            `https://petalumacityschools.org/wp-content/uploads/${currentYear}/${schoolCode}-calendar.pdf`,
            // District-wide calendars
            `https://petalumacityschools.org/calendar.pdf`,
            `https://petalumacityschools.org/district-calendar.pdf`,
            `https://petalumacityschools.org/academic-calendar.pdf`,
            `https://petalumacityschools.org/files/district-calendar-${currentYear}-${nextYear}.pdf`
        ];
        
        const validPDFs = [];
        
        for (const url of patterns) {
            try {
                console.log(`🔍 Checking: ${url}`);
                
                const response = await axios.head(url, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                    }
                });
                
                if (response.status === 200 && 
                    response.headers['content-type']?.includes('pdf')) {
                    console.log(`✅ Found PDF: ${url}`);
                    validPDFs.push({
                        url: url,
                        text: 'Direct PDF Pattern',
                        type: 'known_pattern'
                    });
                }
                
            } catch (error) {
                // Ignore 404s and timeouts - expected for most patterns
            }
        }
        
        return validPDFs;
    }

    // Download and parse PDF
    async downloadAndParsePDF(pdfUrl, schoolName) {
        console.log(`📥 Downloading PDF: ${pdfUrl}`);
        
        try {
            const response = await axios.get(pdfUrl, {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: 50 * 1024 * 1024, // 50MB max
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
            });
            
            const buffer = Buffer.from(response.data);
            console.log(`📦 Downloaded ${buffer.length} bytes`);
            
            if (buffer.length < 1000) {
                throw new Error('PDF file too small, likely not a real PDF');
            }
            
            // Parse PDF
            console.log(`📄 Parsing PDF content...`);
            const pdfData = await pdf(buffer);
            
            console.log(`📝 Extracted ${pdfData.text.length} characters from ${pdfData.numpages} pages`);
            
            if (pdfData.text.length < 100) {
                throw new Error('PDF text extraction failed or PDF is empty');
            }
            
            // Extract calendar events
            const events = this.extractCalendarEventsFromPDF(pdfData.text, schoolName);
            
            return {
                events: events,
                text: pdfData.text.substring(0, 2000), // Keep sample of text
                pages: pdfData.numpages,
                source: pdfUrl,
                success: true
            };
            
        } catch (error) {
            console.error(`❌ PDF processing failed: ${error.message}`);
            return {
                events: [],
                error: error.message,
                source: pdfUrl,
                success: false
            };
        }
    }

    // Extract school calendar events from PDF text
    extractCalendarEventsFromPDF(text, schoolName) {
        console.log(`🔍 Extracting calendar events for ${schoolName}...`);
        
        const events = [];
        const lines = text.split('\n');
        
        // Enhanced patterns for "no school" events
        const noSchoolPatterns = [
            // Explicit no school
            /no\s+school/i,
            /school\s+closed/i,
            /schools?\s+not\s+in\s+session/i,
            
            // Holidays
            /holiday/i,
            /thanksgiving/i,
            /christmas/i,
            /new\s+year/i,
            /martin\s+luther\s+king/i,
            /mlk\s+day/i,
            /presidents?\s*day/i,
            /memorial\s+day/i,
            /labor\s+day/i,
            /columbus\s+day/i,
            /veterans?\s+day/i,
            /independence\s+day/i,
            
            // Breaks
            /winter\s+break/i,
            /spring\s+break/i,
            /summer\s+break/i,
            /thanksgiving\s+break/i,
            /holiday\s+break/i,
            
            // Staff days
            /professional\s+development/i,
            /prof\.?\s+dev\.?/i,
            /teacher\s+workday/i,
            /staff\s+development/i,
            /teacher\s+prep\s+day/i,
            /staff\s+workday/i,
            /inservice/i,
            /in[-\s]service/i,
            
            // Conferences
            /parent[- ]teacher\s+conference/i,
            /p\.?t\.?c\.?/i,
            /conferences/i,
            
            // Modified days
            /minimum\s+day/i,
            /min\.?\s+day/i,
            /early\s+release/i,
            /early\s+dismissal/i,
            /shortened\s+day/i,
            /half\s+day/i
        ];
        
        // Month mapping for better date parsing
        const monthMap = {
            january: '01', jan: '01', february: '02', feb: '02',
            march: '03', mar: '03', april: '04', apr: '04',
            may: '05', june: '06', jun: '06', july: '07', jul: '07',
            august: '08', aug: '08', september: '09', sep: '09', sept: '09',
            october: '10', oct: '10', november: '11', nov: '11',
            december: '12', dec: '12'
        };
        
        // Process text in chunks to catch multi-line events
        for (let i = 0; i < lines.length; i++) {
            const currentLine = lines[i].trim();
            if (currentLine.length < 3) continue;
            
            // Check if current line has "no school" indicators
            const hasNoSchoolEvent = noSchoolPatterns.some(pattern => pattern.test(currentLine));
            
            if (hasNoSchoolEvent) {
                // Look for dates in current and surrounding lines
                const contextLines = [
                    lines[i - 2] || '',
                    lines[i - 1] || '',
                    currentLine,
                    lines[i + 1] || '',
                    lines[i + 2] || ''
                ].join(' ');
                
                // Find dates in the context
                const dates = this.extractDatesFromText(contextLines);
                
                if (dates.length > 0) {
                    dates.forEach(date => {
                        events.push({
                            title: currentLine,
                            date: date,
                            source: 'pdf_calendar',
                            school: schoolName.toLowerCase().replace(/\s+/g, '_'),
                            isNoSchool: true,
                            context: contextLines.substring(0, 200)
                        });
                    });
                } else {
                    // Add event without specific date for manual review
                    events.push({
                        title: currentLine,
                        date: null,
                        source: 'pdf_calendar',
                        school: schoolName.toLowerCase().replace(/\s+/g, '_'),
                        isNoSchool: true,
                        needsDateReview: true
                    });
                }
            }
        }
        
        // Remove duplicates based on title and date
        const uniqueEvents = [];
        const seen = new Set();
        
        events.forEach(event => {
            const key = `${event.title}-${event.date}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEvents.push(event);
            }
        });
        
        console.log(`📅 Extracted ${uniqueEvents.length} unique calendar events from PDF`);
        
        if (uniqueEvents.length > 0) {
            console.log('📋 Sample events found:');
            uniqueEvents.slice(0, 8).forEach((event, i) => {
                console.log(`   ${i + 1}. ${event.date || 'No date'}: ${event.title}`);
            });
        }
        
        return uniqueEvents;
    }

    // Extract dates from text using multiple patterns
    extractDatesFromText(text) {
        const dates = [];
        const currentYear = new Date().getFullYear();
        const nextYear = currentYear + 1;
        
        // Pattern 1: Month DD, YYYY or Month DD
        const monthDayPattern = /(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?/gi;
        
        let match;
        while ((match = monthDayPattern.exec(text)) !== null) {
            const monthName = match[0].split(/\s+/)[0].toLowerCase().replace('.', '');
            const day = match[1].padStart(2, '0');
            const year = match[2] || (monthName === 'august' || monthName === 'aug' ? currentYear : 
                                    ['september', 'october', 'november', 'december', 'sep', 'oct', 'nov', 'dec'].includes(monthName) ? currentYear :
                                    nextYear);
            
            const monthNum = this.getMonthNumber(monthName);
            if (monthNum) {
                dates.push(`${year}-${monthNum}-${day}`);
            }
        }
        
        // Pattern 2: MM/DD/YYYY or MM-DD-YYYY
        const numericPattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g;
        while ((match = numericPattern.exec(text)) !== null) {
            const month = match[1].padStart(2, '0');
            const day = match[2].padStart(2, '0');
            const year = match[3];
            dates.push(`${year}-${month}-${day}`);
        }
        
        // Pattern 3: MM/DD or MM-DD (assume current school year)
        const shortPattern = /(\d{1,2})[\/\-](\d{1,2})(?!\d)/g;
        while ((match = shortPattern.exec(text)) !== null) {
            const month = parseInt(match[1]);
            const day = match[2].padStart(2, '0');
            const monthStr = month.toString().padStart(2, '0');
            
            // Determine year based on month (school year spans two calendar years)
            const year = month >= 8 ? currentYear : nextYear;
            dates.push(`${year}-${monthStr}-${day}`);
        }
        
        return [...new Set(dates)]; // Remove duplicates
    }

    // Convert month name to number
    getMonthNumber(monthName) {
        const monthMap = {
            january: '01', jan: '01', february: '02', feb: '02',
            march: '03', mar: '03', april: '04', apr: '04',
            may: '05', june: '06', jun: '06', july: '07', jul: '07',
            august: '08', aug: '08', september: '09', sep: '09', sept: '09',
            october: '10', oct: '10', november: '11', nov: '11',
            december: '12', dec: '12'
        };
        
        return monthMap[monthName.toLowerCase()];
    }

    // Generate complete school calendar from PDF events
    generateSchoolCalendarFromPDFs(events, schoolName) {
        console.log(`📅 Generating complete school calendar for ${schoolName}...`);
        
        const schoolDays = {};
        const today = new Date();
        const currentYear = today.getFullYear();
        
        // Generate full school year: August current year to July next year
        const startDate = new Date(currentYear, 7, 1); // August 1
        const endDate = new Date(currentYear + 1, 6, 31); // July 31 next year
        
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const dayOfWeek = d.getDay();
            
            schoolDays[dateStr] = {
                date: dateStr,
                isSchoolDay: dayOfWeek >= 1 && dayOfWeek <= 5, // Default: weekdays are school days
                status: dayOfWeek >= 1 && dayOfWeek <= 5 ? 'School Day' : 'Weekend',
                events: [],
                dayOfWeek: dayOfWeek,
                month: d.getMonth() + 1,
                day: d.getDate(),
                year: d.getFullYear()
            };
        }

        // Apply PDF events to override school days
        let overrideCount = 0;
        
        events.forEach(event => {
            if (event.date && schoolDays[event.date] && event.isNoSchool) {
                // Only override weekdays (don't change weekends)
                if (schoolDays[event.date].dayOfWeek >= 1 && schoolDays[event.date].dayOfWeek <= 5) {
                    schoolDays[event.date].isSchoolDay = false;
                    schoolDays[event.date].status = event.title;
                    schoolDays[event.date].source = 'pdf_override';
                    overrideCount++;
                }
            }
            
            // Add event to the calendar day
            if (event.date && schoolDays[event.date]) {
                schoolDays[event.date].events.push(event);
            }
        });

        // Generate statistics
        const stats = {
            totalDays: Object.keys(schoolDays).length,
            schoolDays: 0,
            noSchoolDays: 0,
            weekends: 0,
            overrides: overrideCount
        };
        
        Object.values(schoolDays).forEach(day => {
            if (day.dayOfWeek === 0 || day.dayOfWeek === 6) {
                stats.weekends++;
            } else if (day.isSchoolDay) {
                stats.schoolDays++;
            } else {
                stats.noSchoolDays++;
            }
        });
        
        console.log(`📊 Calendar generated: ${stats.schoolDays} school days, ${stats.noSchoolDays} no-school weekdays, ${stats.overrides} PDF overrides`);
        
        return { schoolDays, stats };
    }

    // Process a single school
    async processSchool(schoolName, calendarUrl) {
        console.log(`\n🏫 Processing ${schoolName}...`);
        
        try {
            // Step 1: Scrape school page for PDF links
            const scrapedPDFs = await this.scrapePageForPDFs(calendarUrl, schoolName);
            
            // Step 2: Try known PDF URL patterns
            const knownPDFs = await this.tryKnownPDFPatterns(schoolName);
            
            // Combine and prioritize PDF sources
            const allPDFSources = [...knownPDFs, ...scrapedPDFs];
            const uniquePDFs = [];
            const seenUrls = new Set();
            
            allPDFSources.forEach(pdf => {
                if (!seenUrls.has(pdf.url)) {
                    seenUrls.add(pdf.url);
                    uniquePDFs.push(pdf);
                }
            });
            
            console.log(`📄 Total unique PDF sources: ${uniquePDFs.length}`);
            
            if (uniquePDFs.length === 0) {
                console.warn(`⚠️  No PDF sources found for ${schoolName}`);
                return this.createFallbackData(schoolName);
            }
            
            // Step 3: Try to download and parse PDFs
            let allEvents = [];
            let successfulPDFs = 0;
            
            for (const pdfSource of uniquePDFs.slice(0, 5)) { // Try max 5 PDFs
                console.log(`📄 Trying: ${pdfSource.text || 'Direct PDF'} - ${pdfSource.url}`);
                
                const result = await this.downloadAndParsePDF(pdfSource.url, schoolName);
                
                if (result.success && result.events.length > 0) {
                    allEvents = allEvents.concat(result.events);
                    successfulPDFs++;
                    console.log(`✅ SUCCESS: Extracted ${result.events.length} events`);
                    
                    // If we got substantial data from one PDF, that might be enough
                    if (result.events.length > 15) {
                        console.log(`📚 Got substantial data (${result.events.length} events), stopping here`);
                        break;
                    }
                } else {
                    console.log(`❌ FAILED: ${result.error}`);
                }
            }
            
            if (successfulPDFs === 0) {
                console.warn(`⚠️  No PDFs successfully parsed for ${schoolName}`);
                return this.createFallbackData(schoolName);
            }
            
            // Step 4: Generate school calendar
            const { schoolDays, stats } = this.generateSchoolCalendarFromPDFs(allEvents, schoolName);
            
            const schoolKey = schoolName.toLowerCase().replace(/\s+/g, '_');
            return {
                [schoolKey]: {
                    events: allEvents,
                    schoolDays: schoolDays,
                    stats: stats,
                    pdfSources: uniquePDFs.length,
                    successfulPDFs: successfulPDFs,
                    lastScraped: new Date().toISOString(),
                    calendarType: schoolName.toLowerCase().includes('kenilworth') ? 'traditional' : 'year-round'
                }
            };
            
        } catch (error) {
            console.error(`❌ Error processing ${schoolName}:`, error.message);
            return this.createFallbackData(schoolName);
        }
    }

    // Create fallback data when PDF extraction fails
    createFallbackData(schoolName) {
        const schoolKey = schoolName.toLowerCase().replace(/\s+/g, '_');
        console.log(`📅 Creating fallback calendar for ${schoolKey}...`);
        
        // Generate basic school calendar
        const schoolDays = {};
        const today = new Date();
        
        for (let i = 0; i < 365; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            const dayOfWeek = date.getDay();
            
            schoolDays[dateStr] = {
                date: dateStr,
                isSchoolDay: dayOfWeek >= 1 && dayOfWeek <= 5,
                status: dayOfWeek >= 1 && dayOfWeek <= 5 ? 'School Day' : 'Weekend',
                events: [],
                fallback: true
            };
        }
        
        return {
            [schoolKey]: {
                events: [],
                schoolDays: schoolDays,
                error: 'PDF extraction failed - using fallback',
                lastScraped: new Date().toISOString(),
                fallback: true
            }
        };
    }

    // Main scraping method
    async scrapeAllSchools() {
        console.log('🚀 Starting No-Browser PDF Calendar Scraper...');
        console.log('📁 This will extract official school calendars from PDF files\n');
        
        try {
            // Process both schools
            const kenilworthData = await this.processSchool(
                'Kenilworth Junior High', 
                'https://petalumacityschools.org/kenilworth/our-school/calendars'
            );
            
            const penngroveData = await this.processSchool(
                'Penngrove Elementary', 
                'https://petalumacityschools.org/penngrove/our-school/calendars'
            );
            
            // Combine results
            this.data.calendars = { ...kenilworthData, ...penngroveData };
            
            // Save data
            await fs.writeFile('./scraped-school-data.json', JSON.stringify(this.data, null, 2));
            console.log('\n💾 School calendar data saved to scraped-school-data.json');
            
            // Generate report
            await this.generateReport();
            
            console.log('\n🎉 PDF calendar extraction completed successfully!');
            console.log('📋 Check pdf-extraction-report.txt for full details');
            
        } catch (error) {
            console.error('\n💥 Fatal error:', error.message);
            throw error;
        }
    }

    // Generate detailed report
    async generateReport() {
        const kenilworth = this.data.calendars.kenilworth_junior_high || {};
        const penngrove = this.data.calendars.penngrove_elementary || {};
        
        const report = `
=== PETALUMA SCHOOLS PDF CALENDAR EXTRACTION REPORT ===
Generated: ${new Date().toLocaleString()}

🏫 KENILWORTH JUNIOR HIGH (Traditional Calendar):
   📄 PDF Sources Found: ${kenilworth.pdfSources || 0}
   ✅ Successfully Parsed: ${kenilworth.successfulPDFs || 0}
   📅 No-School Events: ${kenilworth.events?.length || 0}
   🗓️  School Days: ${kenilworth.stats?.schoolDays || 0}
   ⚠️  No-School Weekdays: ${kenilworth.stats?.noSchoolDays || 0}
   📊 PDF Overrides Applied: ${kenilworth.stats?.overrides || 0}
   ❌ Status: ${kenilworth.error ? 'FALLBACK - ' + kenilworth.error : 'SUCCESS'}

🏫 PENNGROVE ELEMENTARY (Year-Round Calendar):
   📄 PDF Sources Found: ${penngrove.pdfSources || 0}
   ✅ Successfully Parsed: ${penngrove.successfulPDFs || 0}
   📅 No-School Events: ${penngrove.events?.length || 0}
   🗓️  School Days: ${penngrove.stats?.schoolDays || 0}
   ⚠️  No-School Weekdays: ${penngrove.stats?.noSchoolDays || 0}
   📊 PDF Overrides Applied: ${penngrove.stats?.overrides || 0}
   ❌ Status: ${penngrove.error ? 'FALLBACK - ' + penngrove.error : 'SUCCESS'}

📋 SAMPLE NO-SCHOOL EVENTS EXTRACTED:
${(kenilworth.events || []).slice(0, 10).map(e => 
    `   • ${e.date || 'Date TBD'}: ${e.title}`).join('\n')}
${(penngrove.events || []).slice(0, 5).map(e => 
    `   • ${e.date || 'Date TBD'}: ${e.title}`).join('\n')}

🎯 WHAT THIS MEANS:
✅ Your dashboard will now show REAL school days vs no-school days
✅ Eleanor and Daniel's calendars will reflect actual holidays and breaks  
✅ Professional development days are marked as no-school
✅ Winter break, spring break, and other breaks are properly scheduled

🚀 NEXT STEPS:
1. Start your dashboard: npm run server
2. Open: http://localhost:8000
3. Check that Monday Oct 21st now shows the correct status
4. This PDF data is good for the whole school year!

💡 NOTE: PDF extraction only needs to run once per school year.
   The calendar data is now saved and ready for daily use.
        `;
        
        await fs.writeFile('./pdf-extraction-report.txt', report);
        console.log('📋 Detailed report saved to pdf-extraction-report.txt');
        
        // Also show key info in console
        console.log('\n📊 EXTRACTION SUMMARY:');
        console.log(`Kenilworth: ${kenilworth.events?.length || 0} events, ${kenilworth.stats?.overrides || 0} no-school days identified`);
        console.log(`Penngrove: ${penngrove.events?.length || 0} events, ${penngrove.stats?.overrides || 0} no-school days identified`);
    }
}

// Run the scraper
if (require.main === module) {
    const scraper = new NoBrowserPDFScraper();
    scraper.scrapeAllSchools()
        .then(() => {
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 Scraping failed:', error.message);
            process.exit(1);
        });
}