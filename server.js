/**
 * YOMI GATEWAY - SERVER CORE
 * * This is the entry point of the application. It sets up the Express server,
 * handles static assets, and provides the specialized routes for stream resolution
 * and subtitle proxying.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const { addonInterface } = require('./addon');

const app = express();
// Middleware to parse JSON data from frontend configurations
app.use(express.json()); 
const port = process.env.PORT || 7000;
// Serve static assets (logos, images, and the waiting/loading video)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));

// HEALTH CHECK: Pinging this to trick hosting providers (like Koyeb) into keeping the instance running.
app.get('/health', (req, res) => res.status(200).json({ status: 'alive' }));

// ============================================================================
// FIX FOR THE STREMIO VALIDATOR BOT
// Serves the HTML directly with a 200 OK status instead of a redirect to '/'
// ============================================================================
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// MULTI-STAGE PARSING ENGINE (Synchronized with addon.js)
// These functions mirror the logic in addon.js to ensure the Resolver
// picks the correct file when a Torrent contains multiple episodes.
// ============================================================================
function extractEpisodeNumber(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|srt|ass|ssa|vtt|sub|idx)$/i, '')
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, '')
                        .replace(/\b(?:x|h)26[45]\b/gi, '')
                        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10bit|8bit|10-bit|8-bit)\b/gi, '')
                        .replace(/\[[a-fA-F0-9]{8}\]/g, '')
                        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, ' ');

    const explicitRegex = /(?:ep(?:isode)?\.?\s*|ova\s*|s\d+e)0*(\d+)(?:v\d)?\b/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) return parseInt(explicitMatch[1], 10);

    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:v\d)?(?:$|\s)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    
    const bracketMatch = clean.match(/\[0*(\d+)(?:v\d)?\]|\(0*(\d+)(?:v\d)?\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);

    clean = clean.replace(/[\[\]\(\)\{\}_\-\+~,]/g, ' ').trim();
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^0*(\d+)(?:v\d)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

function getBatchRange(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|srt|ass|ssa|vtt|sub|idx)$/i, '')
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, '');
    const batchMatch = clean.match(/\b0*(\d+)\s*(?:-|~|to)\s*0*(\d+)\b/i);
    if (batchMatch) return { start: parseInt(batchMatch[1], 10), end: parseInt(batchMatch[2], 10) };
    return null;
}

function isEpisodeMatch(name, requestedEp) {
    const epNum = parseInt(requestedEp, 10);
    
    // Isolate the filename from the full path to ignore misleading folder names
    const parts = name.split('/');
    const filename = parts[parts.length - 1];
    
    // Priority Inversion - Always check for a specific episode number FIRST
    const extractedEp = extractEpisodeNumber(filename);
    if (extractedEp !== null) {
    // If the parser found a specific number (e.g. "01"), it MUST match what the user clicked
        return extractedEp === epNum;
    }
    
    // Only fall back to batch ranges if the file ITSELF has no specific episode number
	// (e.g., the video file itself is named "Anime_01-12.mkv")
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) {
        return true;
    }
    
    // Fallback for Single Episodes/Movies
    if (epNum === 1 && extractedEp === null) {
        return !/trailer|promo|menu|teaser|ncop|nced/i.test(filename);
    }
    return false;
}
/**
 * Selects the most appropriate file from a list for the requested episode.
 * Prioritizes MKV and larger file sizes (better quality).
 */
function selectEpisodeFile(files, requestedEp) {
    if (!files || files.length === 0) return null;
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name || f.path || ""));
    const matches = videoFiles.filter(f => isEpisodeMatch(f.name || f.path || "", requestedEp));
    if (matches.length > 0) {
        return matches.sort((a, b) => {
            const nameA = (a.name || a.path || "").toLowerCase();
            const nameB = (b.name || b.path || "").toLowerCase();
            const aMkv = nameA.endsWith('.mkv') ? 1 : 0;
            const bMkv = nameB.endsWith('.mkv') ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }
    if (videoFiles.length === 1 && parseInt(requestedEp, 10) === 1) return videoFiles[0];
    return videoFiles.length > 0 ? videoFiles[0] : files[0];
}
	
// ============================================================================
// SUBTITLE PROXY
// Downloads subtitles from Debrid providers and serves them with proper MIME types.
// ============================================================================
app.get('/sub/:provider/:apiKey/:hash/:fileId', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    const { provider, apiKey, hash, fileId } = req.params;
    try {
        let downloadUrl = null;
        let fileName = "sub.srt";
        if (provider === "realdebrid") {
            const list = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { headers: { Authorization: `Bearer ${apiKey}` } });
            const torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            if (torrent) {
                const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
                const fileIdx = info.data.files.findIndex(f => f.id == fileId);
                fileName = info.data.files[fileIdx].path;
                const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: info.data.links[fileIdx] }), { headers: { Authorization: `Bearer ${apiKey}` } });
                downloadUrl = unrestrict.data.download;
            }
        } else if (provider === "torbox") {
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&hash=${hash}&file_id=${fileId}`);
            downloadUrl = dl.data.data;
        }
        if (!downloadUrl) return res.status(404).send("Subtitle not found");
        
        // Provide the correct MIME types depending on subtitle extension.
        // Failing to provide application/x-subrip for .srt files causes Stremio to reject them silently.
        const ext = fileName.split('.').pop().toLowerCase();
        let mime = 'text/plain';
        if (ext === 'vtt') mime = 'text/vtt';
        else if (ext === 'ass' || ext === 'ssa') mime = 'text/x-ssa';
        else if (ext === 'srt') mime = 'application/x-subrip';
        
        const subData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        res.set('Content-Type', mime);
        return res.send(subData.data);
    } catch (e) { res.status(500).send("Error fetching subtitle"); }
});
	
/**
 * Helper: Redirects to a local loading video while Debrid is preparing the file.
 */
function serveLoadingVideo(req, res) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    res.redirect(`${protocol}://${req.headers.host}/waiting.mp4`);
}
// ============================================================================
// STREAM RESOLVER
// Converts a Torrent Hash + Episode Number into a playable direct link.
// Handles magnet addition, file selection, and unrestricting on the fly.	
// ============================================================================
app.get('/resolve/:provider/:apiKey/:hash/:episode?', async (req, res) => {
    const { provider, apiKey, hash, episode } = req.params;
    const requestedEp = episode || "1";
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    try {
        if (provider === "realdebrid") {
            const listRes = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            if (!torrent) {
                const add = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', new URLSearchParams({ magnet }), { headers: { Authorization: `Bearer ${apiKey}` } });
                torrent = { id: add.data.id };
            }
            const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
            
            if (info.data.status !== "downloaded") {
                if (info.data.status === "waiting_files_selection") {
                    const bestFile = selectEpisodeFile(info.data.files, requestedEp);
                    
                    const selectedIds = [];
                    if (bestFile) selectedIds.push(bestFile.id);
                    else selectedIds.push(info.data.files[0].id);

                    // Blindly collect ALL subtitle files in the entire torrent
                    // and force Real-Debrid to cache them alongside the selected video file.
                    // This prevents external subtitle files from being dropped during initial RD caching.
                    info.data.files.forEach(f => {
                        const name = (f.path || f.name || "").toLowerCase();
                        if (/\.(ass|srt|ssa|vtt|sub|idx)$/.test(name)) {
                            if (!selectedIds.includes(f.id)) selectedIds.push(f.id);
                        }
                    });
                    
                    // Omit the URLSearchParams! We're treating the unformatted commas as a string.
                    // This ensures that Real-Debrid actually reads and selects all IDs.
                    const bodyString = 'files=' + selectedIds.join(',');
                    await axios.post('https://api.real-debrid.com/rest/1.0/torrents/selectFiles/' + torrent.id, bodyString, { 
                        headers: { 
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        } 
                    });
                }
                return serveLoadingVideo(req, res);
            }
            
            const fresh = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
            

            // Since we're now downloading multiple files (video + subtitles), fresh.data.links also has multiple entries.
            // find the link that belongs to the VIDEO, otherwise Stremio will stream a text file.
            const bestFileFresh = selectEpisodeFile(fresh.data.files, requestedEp);
            const selectedFiles = fresh.data.files.filter(f => f.selected === 1);
            let videoIdx = selectedFiles.findIndex(f => f.id === (bestFileFresh ? bestFileFresh.id : -1));
            
            if (videoIdx === -1) videoIdx = 0; // Fallback

            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: fresh.data.links[videoIdx] }), { headers: { Authorization: `Bearer ${apiKey}` } });
            return res.redirect(unrestrict.data.download);
        }
        if (provider === "torbox") {
            const list = await axios.get('https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true', { headers: { Authorization: `Bearer ${apiKey}` } });
            let torrent = list.data.data ? list.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase()) : null;
            if (!torrent) {
                const boundary = '----WebKitFormBoundaryYomi';
                await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', `--${boundary}\r\nContent-Disposition: form-data; name="magnet"\r\n\r\n${magnet}\r\n--${boundary}--`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
                return serveLoadingVideo(req, res);
            }
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") return serveLoadingVideo(req, res);
            const bestFile = selectEpisodeFile(torrent.files, requestedEp);
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile ? bestFile.id : 0}`);
            return res.redirect(dl.data.data);
        }
    } catch (e) { return serveLoadingVideo(req, res); }
});
// Register the Stremio Addon SDK Router
app.use('/', getRouter(addonInterface));
app.listen(port, () => console.log(`YOMI ONLINE | PORT ${port}`));
