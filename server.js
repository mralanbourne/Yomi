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

// SMART SELECTOR: Picks correct episode in Batch Torrents
function selectBestFile(files, requestedEp) {
    if (!files || !files.length) return null;
    const epNum = parseInt(requestedEp);
    const epPadded = epNum < 10 ? `0${epNum}` : `${epNum}`;
    const epRegex = new RegExp(`[EePp._\\s\\-\\[]${epNum}\\b|[Ee]pisode\\s*${epNum}\\b|\\b${epPadded}\\b`, 'i');

    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name || f.path || ""));
    const matches = videoFiles.filter(f => epRegex.test(f.name || f.path || ""));
    if (matches.length > 0) {
        return matches.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0];
    }
    return videoFiles.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0];
}

// SUBTITLE PROXY: Serves external subs directly from Cloud
app.get('/sub/:provider/:apiKey/:hash/:fileId', async (req, res) => {
    const { provider, apiKey, hash, fileId } = req.params;
    try {
        if (provider === "realdebrid") {
            const list = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', { headers: { Authorization: `Bearer ${apiKey}` } });
            const torrent = list.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());
            if (torrent) {
                const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
                const fileIdx = info.data.files.findIndex(f => f.id == fileId);
                const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: info.data.links[fileIdx] }), { headers: { Authorization: `Bearer ${apiKey}` } });
                const subData = await axios.get(unrestrict.data.download, { responseType: 'arraybuffer' });
                res.set('Content-Type', 'text/plain');
                return res.send(subData.data);
            }
        }
        if (provider === "torbox") {
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&hash=${hash}&file_id=${fileId}`);
            const subData = await axios.get(dl.data.data, { responseType: 'arraybuffer' });
            res.set('Content-Type', 'text/plain');
            return res.send(subData.data);
        }
        res.status(404).send("Not found");
    } catch (e) { res.status(500).send("Proxy Error"); }
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
                    const bestFile = selectBestFile(info.data.files, requestedEp);
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
            const bestFile = selectBestFile(torrent.files, requestedEp);
            const dl = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile ? bestFile.id : 0}`);
            return res.redirect(dl.data.data);
        }
    } catch (e) { return serveLoadingVideo(req, res); }
});

app.use('/', getRouter(addonInterface));
app.listen(port, () => console.log(`YOMI ONLINE | PORT ${port}`));
