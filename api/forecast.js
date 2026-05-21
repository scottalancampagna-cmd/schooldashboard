const axios = require('axios');

module.exports = async (req, res) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Weather API key not configured' });

    const { lat = 38.2324, lon = -122.6367 } = req.query;
    try {
        const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
        const { data } = await axios.get(url);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Forecast fetch failed', details: err.message });
    }
};
