require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

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

// Static Folders
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'static')));

app.use('/', getRouter(addonInterface));

function serveLoadingVideo(res) {
    res.redirect('http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4');
}

app.get('/resolve/:provider/:apiKey/:hash', async (req, res) => {
    const { provider, apiKey, hash } = req.params;
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    console.log(`[RESOLVE] Provider: ${provider}, Hash: ${hash}`);

    try {
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
                return serveLoadingVideo(res);
            }

            const freshInfo = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { 
                headers: { Authorization: `Bearer ${apiKey}` } 
            });
            
            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link', new URLSearchParams({ link: freshInfo.data.links[0] }), {
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
            });
            
            return res.redirect(unrestrict.data.download);
        }
        
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

            if (!torrent || torrent.download_state !== "completed") return serveLoadingVideo(res);

            const dlRes = await axios.get(`https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}`);
            return res.redirect(dlRes.data.data);
        }
    } catch (e) {
        return serveLoadingVideo(res);
    }
});

app.listen(port, () => {
    console.log(`\nYOMI ONLINE | PORT ${port}\n`);
});
