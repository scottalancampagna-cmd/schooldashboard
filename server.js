// Server for Eleanor & Daniel's School Dashboard
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const PetalumaSchoolScraper = require('./scraper.js');

const app = express();
const PORT = 3001;
const DASHBOARD_PORT = 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Serve the dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to get school data
app.get('/api/school-data', async (req, res) => {
    try {
        const data = await fs.readFile('./school-data.json', 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(404).json({ 
            error: 'No school data found. Run scraper first.',
            message: 'Try: npm run scrape'
        });
    }
});

// API endpoint to trigger fresh scraping
app.post('/api/scrape', async (req, res) => {
    try {
        console.log('🔄 Manual scraping triggered...');
        const scraper = new PetalumaSchoolScraper();
        await scraper.scrapeAllData();
        res.json({ success: true, message: 'Scraping completed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Weather API proxy (to handle CORS)
app.get('/api/weather/:lat/:lon', async (req, res) => {
    try {
        const { lat, lon } = req.params;
        const apiKey = 'e0c8d9e6588b4bfe7c5655ed385a9567'; // Your API key
        const axios = require('axios');
        
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
        const response = await axios.get(url);
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Weather fetch failed' });
    }
});

// Weather forecast proxy
app.get('/api/forecast/:lat/:lon', async (req, res) => {
    try {
        const { lat, lon } = req.params;
        const apiKey = 'e0c8d9e6588b4bfe7c5655ed385a9567';
        const axios = require('axios');
        
        const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
        const response = await axios.get(url);
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Weather forecast failed' });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 School Dashboard Server Started!');
    console.log('📡 API Server: http://localhost:' + PORT);
    console.log('📱 Dashboard: http://localhost:' + PORT);
    console.log('🌐 Network Access: http://[your-ip]:' + PORT);
    console.log('');
    console.log('📋 Available endpoints:');
    console.log('  GET  /                   → Dashboard');
    console.log('  GET  /api/school-data    → School calendar & menu data');
    console.log('  POST /api/scrape         → Trigger fresh scraping');
    console.log('  GET  /api/weather/lat/lon → Current weather');
    console.log('');
    
    // Run initial scraping if no data exists
    checkAndRunInitialScraping();
    
    // Set up automated scraping
    setupAutomatedScraping();
});

async function checkAndRunInitialScraping() {
    try {
        await fs.access('./school-data.json');
        console.log('✅ School data exists');
    } catch {
        console.log('🔄 No school data found, running initial scraping...');
        const scraper = new PetalumaSchoolScraper();
        await scraper.scrapeAllData();
    }
}

function setupAutomatedScraping() {
    // Run scraper daily at 6 AM
    cron.schedule('0 6 * * *', async () => {
        console.log('🌅 Running scheduled scraping at 6 AM...');
        try {
            const scraper = new PetalumaSchoolScraper();
            await scraper.scrapeAllData();
            console.log('✅ Scheduled scraping completed');
        } catch (error) {
            console.error('❌ Scheduled scraping failed:', error);
        }
    });
    
    // Also run on Sunday evenings at 8 PM for weekly refresh
    cron.schedule('0 20 * * 0', async () => {
        console.log('📅 Running weekly scraping refresh...');
        try {
            const scraper = new PetalumaSchoolScraper();
            await scraper.scrapeAllData();
            console.log('✅ Weekly scraping completed');
        } catch (error) {
            console.error('❌ Weekly scraping failed:', error);
        }
    });
    
    console.log('⏰ Automated scraping scheduled:');
    console.log('   📅 Daily at 6:00 AM');
    console.log('   📅 Weekly on Sundays at 8:00 PM');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down server...');
    process.exit(0);
});

// Handle laptop wake from sleep
process.on('SIGUSR2', async () => {
    console.log('💻 Laptop woke from sleep, refreshing school data...');
    try {
        const scraper = new PetalumaSchoolScraper();
        await scraper.scrapeAllData();
    } catch (error) {
        console.error('❌ Wake refresh failed:', error);
    }
});