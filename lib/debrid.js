const axios = require('axios');

// --- 1. CACHE CHECK ---
async function checkRD(hashes, apiKey) {
    try {
        const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashes.join("/")}`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        return Object.keys(res.data).filter(hash => res.data[hash]?.hoster?.length > 0);
    } catch (e) { return []; }
}

async function checkTorbox(hashes, apiKey) {
    try {
        const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=list`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        return res.data.data || [];
    } catch (e) { return []; }
}

// --- 2. ACTIVE DOWNLOAD CHECK ---
async function getActiveRD(apiKey) {
    try {
        const res = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { headers: { Authorization: `Bearer ${apiKey}` } });
        const active = {};
        res.data.forEach(t => {
            if (t.status !== 'downloaded' && t.status !== 'error' && t.status !== 'dead') {
                active[t.hash.toLowerCase()] = t.progress || 0;
            }
        });
        return active;
    } catch (e) { return {}; }
}

async function getActiveTorbox(apiKey) {
    try {
        // FIX: bypass_cache=true zwingt Torbox dazu, uns die echte, sofortige Liste zu geben
        const res = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { headers: { Authorization: `Bearer ${apiKey}` } });
        const active = {};
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                if (t.download_state !== 'completed') {
                    let p = t.progress || 0;
                    if (p <= 1 && p > 0) p = p * 100;
                    active[t.hash.toLowerCase()] = Math.round(p);
                }
            });
        }
        return active;
    } catch (e) { return {}; }
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
