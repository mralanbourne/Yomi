const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "2.5.0",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "Ultimate Hentai Gateway. Advanced Episode Recognition, Multi-Sub & MKV Priority.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [
        { id: "sukebei_trending", type: "series", name: "Trending" },
        { id: "sukebei_top", type: "series", name: "Top Rated" },
        { id: "sukebei_search", type: "series", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "apiKey", type: "text", title: "API Key (RD or TB)", required: true }],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

function parseConfig(config) {
    if (!config) return {};
    if (typeof config === 'object') return config;
    try { return JSON.parse(Buffer.from(config, 'base64').toString()); } catch (e) {
        try { return JSON.parse(decodeURIComponent(config)); } catch (e2) { return {}; }
    }
}

// ULTRA-SMART REGEX: Erkennt Episoden, schließt 1080p, 720p, x264 etc. aus
function isEpisodeMatch(name, requestedEp) {
    const epNum = parseInt(requestedEp, 10);
    const epRegex = new RegExp(`(?:\\b|[_\\-\\[])(?:[Ee]p(?:isode)?\\.?\\s*)?0*${epNum}(?:v\\d)?(?:[\\s_\\]\\.\\-]|$)(?!\\d|0p|p)`, 'i');
    return epRegex.test(name);
}

// DATEI AUSWAHL: Priorisiert MKV für Embedded Subs
function findEpisodeFile(files, requestedEp) {
    if (!files || files.length === 0) return null;
    
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name));
    const matches = videoFiles.filter(f => isEpisodeMatch(f.name, requestedEp));
    
    if (matches.length > 0) {
        // Priorisiere .mkv (wegen Embedded Subs), danach Dateigröße
        return matches.sort((a, b) => {
            const aMkv = a.name.toLowerCase().endsWith('.mkv') ? 1 : 0;
            const bMkv = b.name.toLowerCase().endsWith('.mkv') ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || 0) - (a.size || 0);
        })[0];
    }
    
    // Fallback: Wenn nur eine Datei existiert (Single Torrent)
    if (videoFiles.length === 1) return videoFiles[0];
    return null;
}

// PRÜFT UNCACHED TITEL
function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all|\d+\s*-\s*\d+/i.test(title)) return true; // Batch = Erlaubt
    if (isEpisodeMatch(title, requestedEp)) return true; // Passt exakt = Erlaubt
    
    // Wenn eine ANDERE Episode explizit im Titel steht -> Ausblenden
    const otherEpRegex = /(?:[Ee]p(?:isode)?\.?\s*|\-\s*)\d+\b/i;
    if (otherEpRegex.test(title)) return false; 

    return true; 
}

// ALL-IN SUBTITLE EXTRACTOR
function buildSubs(fileList, provider, apiKey, hash) {
    if (!fileList) return [];
    return fileList
        .filter(f => /\.(srt|ass|ssa|vtt|sub|idx)$/i.test(f.name))
        .map(f => {
            let subLang = 'Unknown';
            if (/ger|deu|deutsch/i.test(f.name)) subLang = 'German';
            else if (/eng|english/i.test(f.name)) subLang = 'English';
            else if (/spa|esp/i.test(f.name)) subLang = 'Spanish';
            else if (/fre|fra/i.test(f.name)) subLang = 'French';
            else if (/ita/i.test(f.name)) subLang = 'Italian';
            
            return {
                id: f.id,
                url: `${process.env.BASE_URL}/sub/${provider}/${apiKey}/${hash}/${f.id}`,
                lang: subLang
            };
        });
}

builder.defineCatalogHandler(async ({ id, extra }) => {
    if (id === "sukebei_trending") return { metas: await getTrendingAdultAnime(), cacheMaxAge: 43200 };
    if (id === "sukebei_top") return { metas: await getTopAdultAnime(), cacheMaxAge: 43200 };
    if (id === "sukebei_search" && extra.search) {
        const [anilistMetas, sukebeiTorrents] = await Promise.all([searchAdultAnime(extra.search), searchSukebeiForHentai(extra.search)]);
        const finalMetas = [...anilistMetas];
        const rawGroups = {};
        sukebeiTorrents.forEach(t => {
            const cleanName = cleanTorrentTitle(t.title);
            if (cleanName.length > 2 && !rawGroups[cleanName]) rawGroups[cleanName] = t;
        });
        Object.keys(rawGroups).forEach(cleanName => {
            if (!anilistMetas.some(m => m.name.toLowerCase().includes(cleanName.toLowerCase()))) {
                finalMetas.push({ id: `sukebei:${Buffer.from(cleanName).toString('base64url')}`, type: 'series', name: cleanName, poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    let meta = null;
    if (id.startsWith('anilist:')) {
        meta = await getAnimeMeta(id.split(':')[1]);
        if (!meta) meta = { id, type: 'series', name: Buffer.from(id.split(':')[2], 'base64url').toString('utf8'), episodes: 24 };
    } else if (id.startsWith('sukebei:')) {
        meta = { id, type: 'series', name: Buffer.from(id.split(':')[1], 'base64url').toString('utf8'), episodes: 24, poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" };
    }

    if (meta) {
        meta.type = 'series';
        const videos = [];
        for (let i = 1; i <= (meta.episodes || 24); i++) {
            videos.push({ id: `${id}:1:${i}`, title: `Episode ${i}`, season: 1, episode: i, released: new Date().toISOString() });
        }
        meta.videos = videos;
    }
    return { meta: meta || { id, type: "movie", name: "Not found" }, cacheMaxAge: 604800 };
});

builder.defineStreamHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    let searchTitle = "", requestedEp = 1;
    
    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[2], 'base64url').toString('utf8'));
        if (parts.length >= 5) requestedEp = parseInt(parts[4], 10);
    } else if (id.startsWith('sukebei:')) {
        searchTitle = sanitizeSearchQuery(Buffer.from(id.split(':')[1], 'base64url').toString('utf8'));
        if (id.split(':').length >= 4) requestedEp = parseInt(id.split(':')[3], 10);
    }

    let torrents = await searchSukebeiForHentai(searchTitle);
    if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

    const hashes = torrents.map(t => t.hash);
    const [rdC, tbC, rdA, tbA] = await Promise.all([
        userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
        userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {},
        userConfig.rdKey ? getActiveRD(userConfig.rdKey) : {},
        userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : {}
    ]);

    const streams = [];
    torrents.forEach(t => {
        const hashLow = t.hash.toLowerCase();
        const files = rdC[hashLow] || tbC[hashLow];
        
        let matchedFile = null;
        let displayTitle = `🌐 Sukebei Network`;

        if (files) {
            matchedFile = findEpisodeFile(files, requestedEp);
            if (!matchedFile) return; // Beinhaltet die Episode nicht!
            displayTitle += `\n🎯 ${matchedFile.name}`;
            
            // Wenn es eine MKV ist, weisen wir den User darauf hin
            if (matchedFile.name.toLowerCase().endsWith('.mkv')) {
                displayTitle += `\n💬 Check player for Embedded Subs`;
            }
        } else {
            if (!isTitleMatchingEpisode(t.title, requestedEp)) return; // Falscher Torrent!
            displayTitle += `\n📄 ${t.title}`;
        }

        const bytes = parseFloat(t.size) * 1024 * 1024 * 1024;
        
        if (userConfig.rdKey) {
            const fRD = rdC[hashLow];
            const prog = rdA[hashLow];
            const name = (fRD || prog === 100) ? `YOMI [⚡ RD]\n💾 ${t.size}` : (prog !== undefined ? `YOMI [⏳ ${prog}%]\n💾 ${t.size}` : `YOMI [☁️ RD DL]\n💾 ${t.size}`);
            streams.push({
                name, title: displayTitle,
                url: `${process.env.BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/${requestedEp}`,
                subtitles: buildSubs(fRD, 'realdebrid', userConfig.rdKey, t.hash),
                behaviorHints: { notWebReady: true, bingeGroup: `rd_${t.hash}` },
                _bytes: bytes
            });
        }

        if (userConfig.tbKey) {
            const fTB = tbC[hashLow];
            const prog = tbA[hashLow];
            const name = (fTB || prog === 100) ? `YOMI [⚡ TB]\n💾 ${t.size}` : (prog !== undefined ? `YOMI [⏳ ${prog}%]\n💾 ${t.size}` : `YOMI [☁️ TB DL]\n💾 ${t.size}`);
            streams.push({
                name, title: displayTitle,
                url: `${process.env.BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/${requestedEp}`,
                subtitles: buildSubs(fTB, 'torbox', userConfig.tbKey, t.hash),
                behaviorHints: { notWebReady: true, bingeGroup: `tb_${t.hash}` },
                _bytes: bytes
            });
        }
    });

    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
