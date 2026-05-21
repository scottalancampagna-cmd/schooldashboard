const axios = require('axios');

function parseIcal(text) {
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n/);

    const events = [];
    let current = null;

    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            current = {};
        } else if (line === 'END:VEVENT' && current) {
            if (current.dtstart) events.push(current);
            current = null;
        } else if (current) {
            const sep = line.indexOf(':');
            if (sep === -1) continue;
            const prop = line.substring(0, sep);
            const val  = line.substring(sep + 1);
            const key  = prop.split(';')[0];

            switch (key) {
                case 'SUMMARY':     current.summary     = val; break;
                case 'LOCATION':    current.location    = val; break;
                case 'DESCRIPTION': current.description = val.replace(/\\n/g, ' ').trim(); break;
                case 'DTSTART':
                    current.allDay  = !val.includes('T');
                    current.dtstart = parseDate(prop, val);
                    break;
                case 'DTEND':
                    current.dtend = parseDate(prop, val);
                    break;
            }
        }
    }
    return events;
}

function parseDate(prop, val) {
    if (!val) return null;
    val = val.trim();

    if (val.length === 8) {
        // All-day: YYYYMMDD — store as local midnight
        return new Date(
            parseInt(val.slice(0, 4)),
            parseInt(val.slice(4, 6)) - 1,
            parseInt(val.slice(6, 8))
        ).toISOString();
    }

    const y  = parseInt(val.slice(0, 4));
    const mo = parseInt(val.slice(4, 6)) - 1;
    const d  = parseInt(val.slice(6, 8));
    const h  = parseInt(val.slice(9, 11))  || 0;
    const mi = parseInt(val.slice(11, 13)) || 0;

    if (val.endsWith('Z')) {
        return new Date(Date.UTC(y, mo, d, h, mi)).toISOString();
    }
    // Floating / TZID — treat as local time
    return new Date(y, mo, d, h, mi).toISOString();
}

module.exports = async (req, res) => {
    const icalUrl = process.env.GCAL_ICAL_URL;
    if (!icalUrl) return res.status(500).json({ error: 'GCAL_ICAL_URL not configured' });

    try {
        const { data } = await axios.get(icalUrl, { responseType: 'text', timeout: 8000 });
        const events = parseIcal(data);

        const start = new Date(); start.setDate(start.getDate() - 1);
        const end   = new Date(); end.setDate(end.getDate() + 60);

        const filtered = events
            .filter(e => {
                const dt = new Date(e.dtstart);
                return dt >= start && dt <= end;
            })
            .sort((a, b) => new Date(a.dtstart) - new Date(b.dtstart))
            .map(e => ({
                summary:  e.summary  || '(No title)',
                location: e.location || null,
                allDay:   e.allDay,
                dtstart:  e.dtstart,
                dtend:    e.dtend || null,
            }));

        res.setHeader('Cache-Control', 's-maxage=300');
        res.json({ events: filtered });
    } catch (err) {
        res.status(502).json({ error: 'Calendar fetch failed', details: err.message });
    }
};
