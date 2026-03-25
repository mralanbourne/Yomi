/**
 * YOMI DEBRID PROVIDER INTERFACE
 * * This module manages communication with Debrid services (Real-Debrid & Torbox).
 * It handles two primary tasks:
 * 1. Cache Checking: Seeing if a torrent is already "instantly" available.
 * 2. Progress Tracking: Monitoring the status of torrents being downloaded to the cloud.
 */

const axios = require('axios');

/**
 * Checks Real-Debrid for "Instant Availability" of a list of hashes.
 * If cached, it returns the file structure of the first available variant.
 * * @param {string[]} hashes - Array of torrent info-hashes.
 * @param {string} apiKey - User's Real-Debrid API Key.
 * @returns {Promise<Object>} - Mapping of hash -> array of files {id, name, size}.
 */
async function checkRD(hashes, apiKey) {
    try {
        // Real-Debrid allows checking multiple hashes by joining them with slashes
        const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashes.join("/")}`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        
        Object.keys(res.data).forEach(hash => {
            const h = hash.toLowerCase();
            const availability = res.data[hash];
            
            // Check if 'rd' (Real-Debrid) has at least one valid variant for this hash
            if (availability && availability.rd && availability.rd.length > 0) {
                let allFiles = [];
                // We pick the first variant ([0]) as it usually contains the most files
                const variant = availability.rd[0];
                Object.keys(variant).forEach(fileId => {
                    allFiles.push({ 
                        id: fileId, 
                        name: variant[fileId].filename, 
                        size: variant[fileId].filesize 
                    });
                });
                results[h] = allFiles;
            }
        });
        return results;
    } catch (e) { 
        // Silently return empty object on error to prevent addon crash
        return {}; 
    }
}

/**
 * Checks Torbox for cached torrents.
 * * @param {string[]} hashes - Array of torrent info-hashes.
 * @param {string} apiKey - User's Torbox API Key.
 * @returns {Promise<Object>} - Mapping of hash -> array of files {id, name, size}.
 */
async function checkTorbox(hashes, apiKey) {
    try {
        // Torbox uses a comma-separated list of hashes
        const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(",")}&format=list&list_files=true`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        const results = {};
        
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                // Map Torbox file structure to our internal Yomi format
                results[t.hash.toLowerCase()] = t.files.map(f => ({ 
                    id: f.id, 
                    name: f.name, 
                    size: f.size 
                }));
            });
        }
        return results;
    } catch (e) { 
        return {}; 
    }
}

/**
 * Retrieves the current active torrent list from Real-Debrid.
 * Used to show download progress (0-100%) for torrents that are NOT yet cached.
 * * @param {string} apiKey - User's Real-Debrid API Key.
 * @returns {Promise<Object>} - Mapping of hash -> progress percentage (0 to 100).
 */
async function getActiveRD(apiKey) {
    try {
        const res = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const active = {};
        
        res.data.forEach(t => {
            if (t.status === 'downloaded') {
                active[t.hash.toLowerCase()] = 100;
            } else if (t.status !== 'error' && t.status !== 'dead') {
                // Return progress or 0 if undefined
                active[t.hash.toLowerCase()] = t.progress || 0;
            }
        });
        return active;
    } catch (e) { 
        return {}; 
    }
}

/**
 * Retrieves the current active torrent list from Torbox.
 * Normalizes progress data to a standard 0-100 integer format.
 * * @param {string} apiKey - User's Torbox API Key.
 * @returns {Promise<Object>} - Mapping of hash -> progress percentage (0 to 100).
 */
async function getActiveTorbox(apiKey) {
    try {
        const res = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const active = {};
        
        if (res.data && res.data.data) {
            res.data.data.forEach(t => {
                if (t.download_state === 'completed' || t.download_state === 'cached') {
                    active[t.hash.toLowerCase()] = 100;
                } else {
                    let p = t.progress || 0;
                    // Normalize: Torbox sometimes returns progress as 0.0 to 1.0
                    if (p <= 1 && p > 0) p = p * 100;
                    active[t.hash.toLowerCase()] = Math.round(p);
                }
            });
        }
        return active;
    } catch (e) { 
        return {}; 
    }
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
