require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { getRouter } = require('stremio-addon-sdk');

const { addonInterface, manifest, parseConfig } = require('./addon');

const app = express();
const port = process.env.PORT || 7000;

app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
});

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Register static folders
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));

// ROUTE: CONFIGURE FIX
app.get('/configure', (req, res) => res.redirect('/'));
app.get('/:config/configure', (req, res) => res.redirect('/'));

// DYNAMIC CATALOG INTERCEPTOR
app.get('/:config/manifest.json', (req, res, next) => {
    try {
        const configStr = req.params.config;
        if (!configStr || configStr === 'manifest.json') return next();
        
        const config = parseConfig(configStr);
        if (!config || Object.keys(config).length === 0) return next();

        const dynamicManifest = JSON.parse(JSON.stringify(manifest));
        
        if (dynamicManifest.behaviorHints) {
            dynamicManifest.behaviorHints.configurationRequired = false;
        }

        const catalogs = [];
        
        if (config.showTrending !== false) {
            catalogs.push({ id: 'sukebei_trending', type: 'movie', name: 'Trending' });
        }
        if (config.showTop !== false) {
            catalogs.push({ id: 'sukebei_top', type: 'movie', name: 'Top Rated' });
        }
        
        catalogs.push({ 
            type: "movie", 
            id: "sukebei_search", 
            name: "Yomi Search", 
            extra: [{ name: "search", isRequired: true }] 
        });

        dynamicManifest.catalogs = catalogs;
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(dynamicManifest);
    } catch (e) {
        next(); 
    }
});

app.use('/', getRouter(addonInterface));

// ============================================================================
// LOCAL VIDEO REDIRECT
// ============================================================================
function serveLoadingVideo(req, res) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers.host;
    const videoUrl = `${protocol}://${host}/waiting.mp4`;
    
    console.log(`[RESOLVE] Torrent not cached. Serving local SSD video: ${videoUrl}`);
    res.redirect(videoUrl);
}

app.get('/resolve/:provider/:apiKey/:hash', async (req, res) => {
    const { provider, apiKey, hash } = req.params;
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    console.log(`[RESOLVE] Provider: ${provider}, Hash: ${hash}`);

    try {
        // --- REAL DEBRID RESOLVER ---
        if (provider === "realdebrid") {
            let torrentId = null;
            const listRes = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', {
                headers: { Authorization: `Bearer ${apiKey}` }
            });
            const existingTorrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
            if (existingTorrent) {
                torrentId = existingTorrent.id;
            } else {
                const addRes = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', new URLSearchParams({ magnet }), {
                    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
                });
                torrentId = addRes.data.id;
            }
            
            const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { 
                headers: { Authorization: `Bearer ${apiKey}` } 
            });
            
            if (infoRes.data.status !== "downloaded") {
                if (infoRes.data.status === "waiting_files_selection") {
                    const biggestFile = infoRes.data.files.sort((a, b) => b.bytes - a.bytes)[0];
                    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, new URLSearchParams({ files: biggestFile.id }), {
                        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
                    });
                }
                return serveLoadingVideo(req, res);
            }

            const freshInfo = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { 
                headers: { Authorization: `Bearer ${apiKey}` } 
            });
            
            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: freshInfo.data.links[0] }), {
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
            });
            
            return res.redirect(unrestrict.data.download);
        }
        
        // --- TORBOX RESOLVER ---
        if (provider === "torbox") {
            const listRes = await axios.get('https://api.torbox.app/v1/api/torrents/me', { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = listRes.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
            if (!torrent) {
                const FormData = require('form-data');
                const data = new FormData();
                data.append('magnet', magnet);
                await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', data, { 
                    headers: { ...data.getHeaders(), Authorization: `Bearer ${apiKey}` } 
                });
                const newListRes = await axios.get('https://api.torbox.app/v1/api/torrents/me', { headers: { Authorization: `Bearer ${apiKey}` } });
                torrent = newListRes.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            }

            // Torbox status check
            if (!torrent || (torrent.download_state !== "completed" && torrent.download_state !== "cached")) {
                return serveLoadingVideo(req, res);
            }

            // ==========================================
            // FIX: File ID Selection & Header Auth for Torbox
            // ==========================================
            let fileId = 1; 
            if (torrent.files && torrent.files.length > 0) {
                const biggestFile = torrent.files.sort((a, b) => b.size - a.size)[0];
                fileId = biggestFile.id;
            }

            // Torbox needs the API Key sent as a Bearer Token in the headers
            const dlRes = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=${torrent.id}&file_id=${fileId}`, {
                headers: { Authorization: `Bearer ${apiKey}` }
            });
            
            return res.redirect(dlRes.data.data);
        }
    } catch (e) {
        console.error("[RESOLVE ERROR]", e.message);
        return serveLoadingVideo(req, res);
    }
});

app.listen(port, () => {
    console.log(`\nYOMI ONLINE | PORT ${port}\n`);
});
