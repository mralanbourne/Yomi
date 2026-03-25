require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const { addonInterface } = require('./addon');

const app = express();
const port = process.env.PORT || 7000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));
app.get('/health', (req, res) => res.status(200).json({ status: 'alive' }));
app.get('/configure', (req, res) => res.redirect('/'));

// ============================================================================
// MULTI-STAGE PARSING ENGINE (Synchronisiert)
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
    
    const batch = getBatchRange(name);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;

    const extractedEp = extractEpisodeNumber(name);
    if (extractedEp !== null) return extractedEp === epNum;

    if (epNum === 1 && extractedEp === null) {
        if (/trailer|promo|menu|teaser/i.test(name)) return false;
        return true;
    }
    return false;
}

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

        const ext = fileName.split('.').pop().toLowerCase();
        let mime = 'text/plain';
        if (ext === 'vtt') mime = 'text/vtt';
        else if (ext === 'ass' || ext === 'ssa') mime = 'text/x-ssa';
        
        const subData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        res.set('Content-Type', mime);
        return res.send(subData.data);
    } catch (e) { res.status(500).send("Error fetching subtitle"); }
});

function serveLoadingVideo(req, res) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    res.redirect(`${protocol}://${req.headers.host}/waiting.mp4`);
}

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
                    await axios.post('https://api.real-debrid.com/rest/1.0/torrents/selectFiles/' + torrent.id, new URLSearchParams({ files: bestFile ? bestFile.id : info.data.files[0].id }), { headers: { Authorization: `Bearer ${apiKey}` } });
                }
                return serveLoadingVideo(req, res);
            }
            const fresh = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
            const selIdx = fresh.data.files.findIndex(f => f.selected === 1);
            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: fresh.data.links[selIdx] || fresh.data.links[0] }), { headers: { Authorization: `Bearer ${apiKey}` } });
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

app.use('/', getRouter(addonInterface));
app.listen(port, () => console.log(`YOMI ONLINE | PORT ${port}`));
