// Local Mac Mini server for Eleanor & Daniel's School Dashboard
// On Vercel, weather is handled by api/weather.js + api/forecast.js serverless functions.
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs').promises;
const path    = require('path');
const cron    = require('node-cron');
const axios   = require('axios');
const { spawn } = require('child_process');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve pre-built school + menu data written by data-updater.js
app.get('/api/school-data', async (req, res) => {
    try {
        const data = await fs.readFile('./school-data.json', 'utf8');
        res.json(JSON.parse(data));
    } catch {
        res.status(404).json({ error: 'No school data found. Run: npm run update-data' });
    }
});

app.get('/api/menu-data', async (req, res) => {
    try {
        const data = await fs.readFile('./menu-data.json', 'utf8');
        res.json(JSON.parse(data));
    } catch {
        res.status(404).json({ error: 'No menu data found. Run: npm run update-data' });
    }
});

// Manually trigger a data update (runs data-updater.js as a child process)
app.post('/api/update-data', (req, res) => {
    console.log('🔄 Manual data update triggered...');
    const child = spawn('node', ['data-updater.js'], { cwd: __dirname });
    let output = '';
    child.stdout.on('data', d => { output += d; process.stdout.write(d); });
    child.stderr.on('data', d => { output += d; process.stderr.write(d); });
    child.on('close', code => {
        if (code === 0) {
            res.json({ success: true, message: 'Data update complete' });
        } else {
            res.status(500).json({ success: false, message: 'Data update failed', output });
        }
    });
});

// Weather proxy (mirrors api/weather.js for local Mac Mini use)
app.get('/api/weather', async (req, res) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Weather API key not configured' });
    const { lat = 38.2324, lon = -122.6367 } = req.query;
    try {
        const { data } = await axios.get(
            `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`
        );
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Weather fetch failed' });
    }
});

// Forecast proxy (mirrors api/forecast.js for local Mac Mini use)
app.get('/api/forecast', async (req, res) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Weather API key not configured' });
    const { lat = 38.2324, lon = -122.6367 } = req.query;
    try {
        const { data } = await axios.get(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`
        );
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Forecast fetch failed' });
    }
});

// Google Calendar proxy (mirrors api/gcal.js for local Mac Mini use)
app.get('/api/gcal', async (req, res) => {
    const gcalHandler = require('./api/gcal');
    return gcalHandler(req, res);
});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 School Dashboard running at http://localhost:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /                  → Dashboard');
    console.log('  GET  /api/school-data   → Calendar data');
    console.log('  GET  /api/menu-data     → Menu data');
    console.log('  POST /api/update-data   → Trigger data-updater.js');
    console.log('  GET  /api/weather       → Current weather');
    console.log('  GET  /api/forecast      → Forecast');

    scheduleDataUpdates();
});

function runDataUpdater() {
    console.log('🔄 Running scheduled data update...');
    const child = spawn('node', ['data-updater.js'], { cwd: __dirname });
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', code => {
        if (code === 0) console.log('✅ Scheduled data update complete');
        else console.error(`❌ Scheduled data update exited with code ${code}`);
    });
}

function scheduleDataUpdates() {
    // Daily at 6 AM — same cadence as GitHub Actions
    cron.schedule('0 6 * * *', runDataUpdater);
    console.log('⏰ Data updates scheduled daily at 6:00 AM');
}

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    process.exit(0);
});

// Log but don't crash on unexpected errors
process.on('uncaughtException', err => console.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
