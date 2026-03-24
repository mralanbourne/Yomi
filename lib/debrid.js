const axios = require('axios');

/**
 * Scannt Real-Debrid Cache und liefert detaillierte File-Listen.
 */
async function checkRD(hashes, apiKey) {
    try {
        const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashes.join("/")}`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        
        Object.keys(res.data).forEach(hash => {
            const h = hash.toLowerCase();
            const availability = res.data[hash];
            if (availability && availability.rd && availability.rd.length > 0) {
                let files = [];
                // Wir nehmen die erste Variante, die Dateien enthält (meist die vollständigste)
                const variant = availability.rd[0];
                Object.keys(variant).forEach(fileId => {
                    files.push({
                        id: fileId,
                        name: variant[fileId].filename,
                        size: variant[fileId].filesize
                    });
                });
                results[h] = files;
            }
        });
        return results;
    } catch (e) { return {}; }
}

/**
 * Scannt Torbox inklusive File-Listing über list_files=true.
 */
async function checkTorbox(hashes, apiKey) {
    try {
        const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=list&list_files=true`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                results[t.hash.toLowerCase()] = t.files.map(f => ({
                    id: f.id,
                    name: f.name,
                    size: f.size
                }));
            });
        }
        return results;
    } catch (e) { return {}; }
}

async function getActiveRD(apiKey) {
    try {
        const res = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { headers: { Authorization: `Bearer ${apiKey}` } });
        const active = {};
        res.data.forEach(t => {
            if (t.status === 'downloaded') active[t.hash.toLowerCase()] = 100;
            else if (t.status !== 'error' && t.status !== 'dead') active[t.hash.toLowerCase()] = t.progress || 0;
        });
        return active;
    } catch (e) { return {}; }
}

async function getActiveTorbox(apiKey) {
    try {
        const res = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { headers: { Authorization: `Bearer ${apiKey}` } });
        const active = {};
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                if (t.download_state === 'completed' || t.download_state === 'cached') active[t.hash.toLowerCase()] = 100;
                else {
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
