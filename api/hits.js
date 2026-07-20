module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const url   = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        return res.status(200).json({ count: null, error: 'counter not configured' });
    }

    try {
        const r = await fetch(`${url}/incr/schooldashboard_hits`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        const { result } = await r.json();
        res.status(200).json({ count: result });
    } catch (err) {
        res.status(200).json({ count: null, error: err.message });
    }
};
