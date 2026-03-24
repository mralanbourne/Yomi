require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { getRouter } = require('stremio-addon-sdk');
const { addonInterface, manifest, parseConfig } = require('./addon');

const app = express();
const port = process.env.PORT || 7000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));
app.get('/health', (req, res) => res.status(200).json({ status: 'alive' }));
app.get('/configure', (req, res) => res.redirect('/'));
app.use('/', getRouter(addonInterface));

function serveLoadingVideo(req, res) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    res.redirect(`${protocol}://${req.headers.host}/waiting.mp4`);
}

function selectBestFile(files, requestedEp) {
    if (!files || !files.length) return 0;
    const epNum = parseInt(requestedEp);
    const epPadded = epNum < 10 ? `0${epNum}` : `${epNum}`;
    const epRegex = new RegExp(`[EePp._\\s]${epNum}\\b|[Ee]pisode\\s*${epNum}\\b|\\b${epPadded}\\b`, 'i');

    const videoMatches = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name || f.path || "") && epRegex.test(f.name || f.path || ""));
    if (videoMatches.length > 0) return videoMatches.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0].id;
    
    const biggest = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name || f.path || "")).sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0];
    return biggest ? biggest.id : (files[0].id || 0);
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
                    const fileId = selectBestFile(info.data.files, requestedEp);
                    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrent.id}`, new URLSearchParams({ files: fileId }), { headers: { Authorization: `Bearer ${apiKey}` } });
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
            const fileId = selectBestFile(torrent.files, requestedEp);
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${fileId}`);
            return res.redirect(dl.data.data);
        }
    } catch (e) { return serveLoadingVideo(req, res); }
});

app.listen(port, () => console.log(`YOMI ONLINE | PORT ${port}`));
