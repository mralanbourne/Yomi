const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "1.0.0",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "The Forbidden Gateway to Sukebei",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [
        { id: "sukebei_trending", type: "movie", name: "Trending" },
        { id: "sukebei_top", type: "movie", name: "Top Rated" },
        { id: "sukebei_search", type: "movie", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "apiKey", type: "text", title: "API Key", required: true }],
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
                finalMetas.push({ id: `sukebei:${Buffer.from(cleanName).toString('base64url')}`, type: 'movie', name: cleanName, poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    if (id.startsWith('anilist:')) {
        const meta = await getAnimeMeta(id.split(':')[1]);
        if (meta && meta.type === 'series') {
            const videos = [];
            for (let i = 1; i <= (meta.episodes || 1); i++) {
                videos.push({ id: `${id}:1:${i}`, title: `Episode ${i}`, season: 1, episode: i, released: new Date().toISOString() });
            }
            meta.videos = videos;
        }
        return { meta, cacheMaxAge: 604800 };
    } else if (id.startsWith('sukebei:')) {
        return { meta: { id, type: 'movie', name: Buffer.from(id.split(':')[1], 'base64url').toString('utf8'), poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ARESULT" }, cacheMaxAge: 604800 };
    }
    return { meta: { id, type: "movie", name: "Not found" } };
});

builder.defineStreamHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    let searchTitle = "", requestedEpisode = 1;
    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[2], 'base64url').toString('utf8'));
        if (parts.length >= 5) requestedEpisode = parseInt(parts[4]);
        if (parts.length >= 5) searchTitle += ` ${requestedEpisode < 10 ? '0'+requestedEpisode : requestedEpisode}`;
    } else if (id.startsWith('sukebei:')) {
        searchTitle = sanitizeSearchQuery(Buffer.from(id.split(':')[1], 'base64url').toString('utf8'));
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
        const { res, lang } = extractTags(t.title);
        const bytes = parseSizeToBytes(t.size);
        const desc = `🌐 Sukebei Network\n💾 ${t.size} | 👤 ${t.seeders} | 🗣️ ${lang}\n📄 ${t.title}`;

        if (userConfig.rdKey) {
            const prog = rdA[t.hash];
            const name = (rdC[t.hash] || prog === 100) ? `YOMI [⚡ RD]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% RD]\n🎥 ${res}` : `YOMI [☁️ RD DL]\n🎥 ${res}`);
            streams.push({ name, title: desc, url: `${process.env.BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/${requestedEpisode}`, behaviorHints: { notWebReady: true, bingeGroup: `rd_${t.hash}` }, _bytes: bytes });
        }
        if (userConfig.tbKey) {
            const prog = tbA[t.hash];
            const name = (tbC[t.hash] || prog === 100) ? `YOMI [⚡ TB]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% TB]\n🎥 ${res}` : `YOMI [☁️ TB DL]\n🎥 ${res}`);
            streams.push({ name, title: desc, url: `${process.env.BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/${requestedEpisode}`, behaviorHints: { notWebReady: true, bingeGroup: `tb_${t.hash}` }, _bytes: bytes });
        }
    });

    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
