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

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));

app.get('/configure', (req, res) => res.redirect('/'));
app.get('/:config/configure', (req, res) => res.redirect('/'));

app.get('/:config/manifest.json', (req, res, next) => {
    try {
        const configStr = req.params.config;
        if (!configStr || configStr === 'manifest.json') return next();
        const config = parseConfig(configStr);
        if (!config || Object.keys(config).length === 0) return next();
        const dynamicManifest = JSON.parse(JSON.stringify(manifest));
        if (dynamicManifest.behaviorHints) dynamicManifest.behaviorHints.configurationRequired = false;
        const catalogs = [];
        if (config.showTrending !== false) catalogs.push({ id: 'sukebei_trending', type: 'movie', name: 'Trending' });
        if (config.showTop !== false) catalogs.push({ id: 'sukebei_top', type: 'movie', name: 'Top Rated' });
        catalogs.push({ type: "movie", id: "sukebei_search", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] });
        dynamicManifest.catalogs = catalogs;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(dynamicManifest);
    } catch (e) { next(); }
});

app.use('/', getRouter(addonInterface));

function serveLoadingVideo(req, res) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers.host;
    const videoUrl = `${protocol}://${host}/waiting.mp4`;
    console.log(`[RESOLVE] Torrent not ready. Serving waiting video.`);
    res.redirect(videoUrl);
}

/**
 * Hilfsfunktion: Wählt die passende Datei aus einem Torrent aus.
 * Sucht nach der Episodennummer im Dateinamen. Fallback ist die größte Videodatei.
 */
function selectBestFile(files, requestedEp) {
    if (!files || files.length === 0) return null;
    
    const epNum = parseInt(requestedEp, 10);
    const epPadded = epNum < 10 ? `0${epNum}` : `${epNum}`;

    // Regex für Muster wie "E01", "Ep.01", " 01 ", "Episode 1"
    const epRegex = new RegExp(`[EePp._\\s]${epNum}\\b|[Ee]pisode\\s*${epNum}\\b|\\b${epPadded}\\b`, 'i');

    const videoFiles = files.filter(f => {
        const name = f.name || f.path || "";
        return /\.(mkv|mp4|avi|wmv)$/i.test(name);
    });

    // Versuch 1: Genaue Episoden-Suche
    const matches = videoFiles.filter(f => epRegex.test(f.name || f.path || ""));
    if (matches.length > 0) {
        // Falls mehrere (z.B. Preview und Episode), nimm die größte
        return matches.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0];
    }

    // Fallback: Einfach die größte Videodatei (meistens bei Movies oder Single-OVAs)
    return videoFiles.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0];
}

// ROUTE: RESOLVER (Jetzt mit Episoden-Support)
app.get('/resolve/:provider/:apiKey/:hash/:episode?', async (req, res) => {
    const { provider, apiKey, hash, episode } = req.params;
    const requestedEp = episode || "1";
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    
    console.log(`[RESOLVE] Provider: ${provider}, Hash: ${hash}, Ep: ${requestedEp}`);

    try {
        if (provider === "realdebrid") {
            let torrentId = null;
            const listRes = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', {
                headers: { Authorization: `Bearer ${apiKey}` }
            });
            const existingTorrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            
            if (existingTorrent) torrentId = existingTorrent.id;
            else {
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
                    // Smart File Selection für Real-Debrid
                    const bestFile = selectBestFile(infoRes.data.files, requestedEp);
                    const fileId = bestFile ? bestFile.id : infoRes.data.files.sort((a, b) => b.bytes - a.bytes)[0].id;
                    
                    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, new URLSearchParams({ files: fileId }), {
                        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
                    });
                }
                return serveLoadingVideo(req, res);
            }

            const freshInfo = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { 
                headers: { Authorization: `Bearer ${apiKey}` } 
            });
            
            // Finde den korrekten Link in der Liste der selektierten Dateien
            const selectedIdx = freshInfo.data.files.findIndex(f => f.selected === 1);
            const linkToUnrestrict = freshInfo.data.links[selectedIdx] || freshInfo.data.links[0];

            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: linkToUnrestrict }), {
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
            });
            return res.redirect(unrestrict.data.download);
        }
        
        if (provider === "torbox") {
            const listRes = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = listRes.data.data ? listRes.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase()) : null;
            
            if (!torrent) {
                const boundary = '----WebKitFormBoundaryYomiTorbox';
                const payload = `--${boundary}\r\nContent-Disposition: form-data; name="magnet"\r\n\r\n${magnet}\r\n--${boundary}--`;
                await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', payload, { 
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` } 
                });
                await new Promise(r => setTimeout(r, 1500));
                const newListRes = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { headers: { Authorization: `Bearer ${apiKey}` } });
                torrent = newListRes.data.data ? newListRes.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase()) : null;
            }

            if (!torrent || (torrent.download_state !== "completed" && torrent.download_state !== "cached")) return serveLoadingVideo(req, res);

            // Smart File Selection für Torbox
            const bestFile = selectBestFile(torrent.files, requestedEp);
            const fileId = bestFile ? bestFile.id : 0;

            console.log(`[TORBOX] Selected File ID: ${fileId} for Ep: ${requestedEp}`);
            
            const dlRes = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${fileId}`);
            return res.redirect(dlRes.data.data);
        }
    } catch (e) {
        console.error(`[RESOLVE ERROR]`, e.message);
        return serveLoadingVideo(req, res);
    }
});

app.listen(port, () => {
    console.log(`\nYOMI ONLINE | PORT ${port}\n`);
});
