const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "2.1.0",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "Ultimate Anime Gateway. Smart Episode Filtering, Batch Support & Proxy Subtitles.",
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

function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    if (match[2].toLowerCase().includes('g')) return val * 1073741824;
    if (match[2].toLowerCase().includes('m')) return val * 1048576;
    return val;
}

function extractTags(title) {
    let res = "SD", lang = "Raw";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    
    if (/(eng|english)/i.test(title)) lang = "Eng Sub";
    else if (/(multi|dual)/i.test(title)) lang = "Multi";
    else if (/(sub)/i.test(title)) lang = "Subbed";
    if (/(uncensored|decensored)/i.test(title)) lang += " | Uncen";
    return { res, lang };
}

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Prüft ob ein Torrent-Titel zu unserer Episode passt (lässt Batches durch)
function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all|\d+\s*-\s*\d+/i.test(title)) return true; 
    
    const epNum = parseInt(requestedEp, 10);
    const epPadded = epNum < 10 ? `0${epNum}` : `${epNum}`;
    const epRegex = new RegExp(`(?:[Ee]p(?:isode)?\\.?\\s*|\\-\\s*|\\b[Oo][Vv][Aa]\\s*|\\b|_|\\[)(?:0*)${epNum}(?:v\\d)?(?:\\b|_|\\]|\\.)`, 'i');
    
    if (epRegex.test(title)) return true;

    // Wenn der Titel explizit eine ANDERE Folge nennt -> Aussortieren
    const otherEpRegex = /(?:[Ee]p(?:isode)?\.?\s*|\-\s*|\b[Oo][Vv][Aa]\s*)\d+\b/i;
    if (otherEpRegex.test(title)) return false; 

    return true; // Fallback: Anzeigen, falls unsicher
}

// Sucht die exakte Datei im Debrid-Cache
function findEpisodeInFiles(files, requestedEp) {
    if (!files || files.length === 0) return null;
    const epNum = parseInt(requestedEp, 10);
    const epRegex = new RegExp(`(?:[Ee]p(?:isode)?\\.?\\s*|\\-\\s*|\\b[Oo][Vv][Aa]\\s*|\\b|_|\\[)(?:0*)${epNum}(?:v\\d)?(?:\\b|_|\\]|\\.)`, 'i');
    
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name));
    const matches = videoFiles.filter(f => epRegex.test(f.name));
    
    if (matches.length > 0) return matches.sort((a, b) => b.size - a.size)[0];
    if (videoFiles.length === 1) return videoFiles[0]; 
    return null;
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
    
    // Wir fragen nur AniList. Keine Torrent-Suchen hier, das macht das Addon pfeilschnell!
    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        meta = await getAnimeMeta(parts[1]);
        if (!meta) meta = { id, type: 'series', name: Buffer.from(parts[2], 'base64url').toString('utf8'), episodes: 12 };
    } else if (id.startsWith('sukebei:')) {
        meta = { id, type: 'series', name: Buffer.from(id.split(':')[1], 'base64url').toString('utf8'), episodes: 12, poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" };
    }

    if (meta) {
        meta.type = 'series'; // Zwingt Stremio in die Folgenansicht
        const videos = [];
        const count = meta.episodes || 12; // Fallback auf 12 Folgen
        for (let i = 1; i <= count; i++) {
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
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (parts.length >= 4) requestedEp = parseInt(parts[3], 10);
    }

    // JETZT erst suchen wir die Torrents für die Auswahl-Liste
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
        
        let displayTitle = `🌐 Sukebei Network\n💾 ${t.size} | 👤 ${t.seeders}`;
        
        // WICHTIG: Das ist der Filter für deine Torrent-Auswahl
        if (files) {
            const matchedFile = findEpisodeInFiles(files, requestedEp);
            if (!matchedFile) return; // Verstecke Torrents, die diese Folge nicht haben!
            displayTitle += `\n🎯 File: ${matchedFile.name}`;
        } else {
            if (!isTitleMatchingEpisode(t.title, requestedEp)) return; // Verstecke falsche Uncached Torrents!
            displayTitle += `\n📄 ${t.title}`;
        }

        const { res, lang } = extractTags(t.title);
        const bytes = parseFloat(t.size) * 1024 * 1024 * 1024;
        
        const buildSubs = (fileList, provider, apiKey) => {
            if (!fileList) return [];
            return fileList
                .filter(f => /\.(ass|srt|ssa|vtt)$/i.test(f.name))
                .map(f => {
                    let subLang = 'English';
                    if (/ger|deu|deutsch/i.test(f.name)) subLang = 'German';
                    else if (/spa|esp/i.test(f.name)) subLang = 'Spanish';
                    return { id: f.id, url: `${process.env.BASE_URL}/sub/${provider}/${apiKey}/${t.hash}/${f.id}`, lang: subLang };
                });
        };

        if (userConfig.rdKey) {
            const fRD = rdC[hashLow];
            const prog = rdA[hashLow];
            const name = (fRD || prog === 100) ? `YOMI [⚡ RD]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% RD]\n🎥 ${res}` : `YOMI [☁️ RD DL]\n🎥 ${res}`);
            streams.push({ name, title: displayTitle, url: `${process.env.BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/${requestedEp}`, subtitles: buildSubs(fRD, 'realdebrid', userConfig.rdKey), behaviorHints: { notWebReady: true, bingeGroup: `rd_${t.hash}` }, _bytes: bytes });
        }

        if (userConfig.tbKey) {
            const fTB = tbC[hashLow];
            const prog = tbA[hashLow];
            const name = (fTB || prog === 100) ? `YOMI [⚡ TB]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% TB]\n🎥 ${res}` : `YOMI [☁️ TB DL]\n🎥 ${res}`);
            streams.push({ name, title: displayTitle, url: `${process.env.BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/${requestedEp}`, subtitles: buildSubs(fTB, 'torbox', userConfig.tbKey), behaviorHints: { notWebReady: true, bingeGroup: `tb_${t.hash}` }, _bytes: bytes });
        }
    });

    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
