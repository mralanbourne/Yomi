const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "1.3.5",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "Ultra-Smart Gateway. Dynamic Content-Based Episode Slots & Subtitle Proxying.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [
        { id: "sukebei_trending", type: "movie", name: "Trending" },
        { id: "sukebei_top", type: "movie", name: "Top Rated" },
        { id: "sukebei_search", type: "movie", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
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
    const unit = match[2].toLowerCase();
    if (unit.includes('g')) return val * 1073741824;
    if (unit.includes('m')) return val * 1048576;
    return val;
}

function extractTags(title) {
    let res = "SD";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    let lang = "Raw";
    if (/(eng|english)/i.test(title)) lang = "Eng Sub";
    else if (/(multi|dual)/i.test(title)) lang = "Multi";
    else if (/(sub)/i.test(title)) lang = "Subbed";
    if (/(uncensored|decensored)/i.test(title)) lang += " | Uncen";
    return { res, lang };
}

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// --- CATALOG HANDLER ---
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
                finalMetas.push({ 
                    id: `sukebei:${Buffer.from(cleanName).toString('base64url')}`, 
                    type: 'series',
                    name: cleanName, 
                    poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

// --- META HANDLER (DYNAMIC EPISODE SLOTS) ---
builder.defineMetaHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    let meta = null;
    let titleForSearch = "";

    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        meta = await getAnimeMeta(parts[1]);
        titleForSearch = meta ? meta.name : Buffer.from(parts[2], 'base64url').toString('utf8');
        if (!meta) meta = { id, type: 'series', name: titleForSearch, episodes: 1 };
    } else if (id.startsWith('sukebei:')) {
        titleForSearch = Buffer.from(id.split(':')[1], 'base64url').toString('utf8');
        meta = { id, type: 'series', name: titleForSearch, episodes: 1, poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" };
    }

    if (meta) {
        const videos = [];
        // ULTRA-SMART: Find the best torrent, count video files, and name the slots accordingly
        try {
            const torrents = await searchSukebeiForHentai(titleForSearch);
            if (torrents && torrents.length > 0) {
                const bestTorrent = torrents[0];
                const [rdC, tbC] = await Promise.all([
                    userConfig.rdKey ? checkRD([bestTorrent.hash], userConfig.rdKey) : {},
                    userConfig.tbKey ? checkTorbox([bestTorrent.hash], userConfig.tbKey) : {}
                ]);
                
                const fileList = rdC[bestTorrent.hash.toLowerCase()] || tbC[bestTorrent.hash.toLowerCase()];
                if (fileList) {
                    const videoFiles = fileList.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name)).sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
                    if (videoFiles.length > 1) {
                        videoFiles.forEach((f, index) => {
                            videos.push({
                                id: `${id}:1:${index + 1}`,
                                title: f.name.replace(/\.(mkv|mp4|avi|wmv)$/i, ''),
                                season: 1,
                                episode: index + 1,
                                released: new Date().toISOString()
                            });
                        });
                    }
                }
            }
        } catch (e) { console.error("[Meta Smart Scan Error]", e.message); }

        // Fallback to AniList count or 24 standard slots if no specific files detected
        if (videos.length === 0) {
            const count = meta.episodes || 24;
            for (let i = 1; i <= count; i++) {
                videos.push({ id: `${id}:1:${i}`, title: `Episode ${i}`, season: 1, episode: i, released: new Date().toISOString() });
            }
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
        if (parts.length >= 5) {
            requestedEp = parseInt(parts[4]);
            searchTitle += ` ${requestedEp < 10 ? '0'+requestedEp : requestedEp}`;
        }
    } else if (id.startsWith('sukebei:')) {
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (id.split(':').length >= 4) requestedEp = parseInt(id.split(':')[3]);
    }

    const torrents = await searchSukebeiForHentai(searchTitle);
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
        const bytes = parseFloat(t.size) * 1024 * 1024 * 1024;
        const descBase = `🌐 Sukebei Network\n💾 ${t.size} | 👤 ${t.seeders}`;
        
        const buildSubs = (fileList, provider, apiKey) => {
            if (!fileList) return [];
            return fileList
                .filter(f => /\.(ass|srt|ssa|vtt)$/i.test(f.name))
                .map(f => ({
                    id: f.id,
                    url: `${process.env.BASE_URL}/sub/${provider}/${apiKey}/${t.hash}/${f.id}`,
                    lang: f.name.toLowerCase().includes('ger') ? 'German' : 'English'
                }));
        };

        const addStream = (provider, cache, active, apiKey, label) => {
            const files = cache[t.hash.toLowerCase()];
            const prog = active[t.hash.toLowerCase()];
            let name = `YOMI [☁️ ${label} DL]`;
            if (files || prog === 100) name = `YOMI [⚡ ${label}]`;
            else if (prog !== undefined) name = `YOMI [⏳ ${prog}% ${label}]`;

            let displayTitle = descBase + `\n📄 ${t.title}`;
            if (files) {
                const epPadded = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
                const epRegex = new RegExp(`[EePp._\\s\\-\\[]${requestedEp}\\b|\\b${epPadded}\\b`, 'i');
                const match = files.find(f => /\.(mkv|mp4|avi)$/i.test(f.name) && epRegex.test(f.name));
                if (match) displayTitle = descBase + `\n🎯 Match: ${match.name}`;
            }

            streams.push({
                name, title: displayTitle,
                url: `${process.env.BASE_URL}/resolve/${provider}/${apiKey}/${t.hash}/${requestedEp}`,
                subtitles: buildSubs(files, provider, apiKey),
                behaviorHints: { notWebReady: true, bingeGroup: `${label}_${t.hash}` },
                _bytes: bytes
            });
        };

        if (userConfig.rdKey) addStream('realdebrid', rdC, rdA, userConfig.rdKey, 'RD');
        if (userConfig.tbKey) addStream('torbox', tbC, tbA, userConfig.tbKey, 'TB');
    });

    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
