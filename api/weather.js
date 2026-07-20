module.exports = async (req, res) => {
    const { lat = 38.2324, lon = -122.6367 } = req.query;
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
        `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles`;
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Weather fetch failed', details: err.message });
    }
};
