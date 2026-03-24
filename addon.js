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
    try {
        return JSON.parse(Buffer.from(config, 'base64').toString());
    } catch (e) {
        try { 
            return JSON.parse(decodeURIComponent(config)); 
        } catch (e2) { 
            return {}; 
        }
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
    if (unit.includes('k')) return val * 1024;
    return val;
}

function extractTags(title) {
    let res = "SD";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    else if (/(480p|480)/i.test(title)) res = "480p";

    let lang = "Raw";
    if (/(eng|english)/i.test(title)) lang = "Eng Sub";
    else if (/(multi|dual)/i.test(title)) lang = "Multi";
    else if (/(sub)/i.test(title)) lang = "Subbed";

    if (/(uncensored|decensored)/i.test(title)) {
        lang += " | Uncen";
    }

    return { res, lang };
}

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

builder.defineCatalogHandler(async ({ id, extra }) => {
    if (id === "sukebei_trending") {
        const metas = await getTrendingAdultAnime();
        return { metas, cacheMaxAge: 43200 };
    }
    if (id === "sukebei_top") {
        const metas = await getTopAdultAnime();
        return { metas, cacheMaxAge: 43200 };
    }
    if (id === "sukebei_search" && extra.search) {
        if (extra.search.length < 3) return { metas: [] };
        const [anilistMetas, sukebeiTorrents] = await Promise.all([
            searchAdultAnime(extra.search),
            searchSukebeiForHentai(extra.search)
        ]);
        const finalMetas = [...anilistMetas];
        const rawGroups = {};
        sukebeiTorrents.forEach(t => {
            const cleanName = cleanTorrentTitle(t.title);
            if (cleanName.length > 2) {
                if (!rawGroups[cleanName]) rawGroups[cleanName] = [];
                rawGroups[cleanName].push(t);
            }
        });
        for (const [cleanName, torrents] of Object.entries(rawGroups)) {
            const existsInAnilist = anilistMetas.some(m => 
                m.name.toLowerCase().includes(cleanName.toLowerCase()) || 
                cleanName.toLowerCase().includes(m.name.toLowerCase())
            );
            if (!existsInAnilist) {
                const base64Title = Buffer.from(cleanName).toString('base64url');
                finalMetas.push({
                    id: `sukebei:${base64Title}`,
                    type: 'movie',
                    name: cleanName,
                    poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ASUKEBEI%0ARESULT",
                    description: "Direct search result from the Sukebei network."
                });
            }
        }
        const cacheAge = finalMetas.length === 0 ? 60 : 86400;
        return { metas: finalMetas, cacheMaxAge: cacheAge };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    if (id.startsWith('anilist:')) {
        const anilistId = id.split(':')[1]; 
        const meta = await getAnimeMeta(anilistId);
        if (meta) return { meta: meta, cacheMaxAge: 604800 };
    } 
    else if (id.startsWith('sukebei:')) {
        const base64Title = id.split(':')[1];
        const cleanName = Buffer.from(base64Title, 'base64url').toString('utf8');
        return { 
            meta: {
                id: id,
                type: 'movie',
                name: cleanName,
                poster: "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ASUKEBEI%0ARESULT",
                description: "Direct search result from the Sukebei network."
            }, 
            cacheMaxAge: 604800 
        };
    }
    return { meta: { id: id, type: "movie", name: "Not found" } }; 
});

builder.defineStreamHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

    try {
        let searchTitle = "";
        let requestedEpisode = 1;

        if (id.startsWith('anilist:')) {
            const idParts = id.split(':');
            if (idParts.length < 3) return { streams: [] };
            let rawTitle = Buffer.from(idParts[2], 'base64url').toString('utf8');
            searchTitle = sanitizeSearchQuery(rawTitle);
            
            // Extrahiere Episodennummer für Serien
            if (idParts.length >= 5) {
                requestedEpisode = parseInt(idParts[4], 10);
                const epString = requestedEpisode < 10 ? `0${requestedEpisode}` : `${requestedEpisode}`;
                searchTitle = `${searchTitle} ${epString}`;
            }
        } else if (id.startsWith('sukebei:')) {
            const idParts = id.split(':');
            if (idParts.length < 2) return { streams: [] };
            let rawTitle = Buffer.from(idParts[1], 'base64url').toString('utf8');
            searchTitle = sanitizeSearchQuery(rawTitle);
            if (idParts.length >= 4) {
                requestedEpisode = parseInt(idParts[3], 10);
                const epString = requestedEpisode < 10 ? `0${requestedEpisode}` : `${requestedEpisode}`;
                searchTitle = `${searchTitle} ${epString}`;
            }
        } else {
            return { streams: [] };
        }

        const torrents = await searchSukebeiForHentai(searchTitle);
        if (torrents.length === 0) return { streams: [], cacheMaxAge: 60 }; 

        const hashes = torrents.map(t => t.hash);
        const [rdCached, tbCached, rdActive, tbActive] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : Promise.resolve([]),
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : Promise.resolve([]),
            userConfig.rdKey ? getActiveRD(userConfig.rdKey) : Promise.resolve({}),
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : Promise.resolve({})
        ]);

        let streams = [];
        torrents.forEach(t => {
            const { res, lang } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            const streamDescription = `🌐 Sukebei Network\n💾 ${t.size}  |  👤 ${t.seeders}  |  🗣️ ${lang}\n📄 ${t.title}`;

            if (userConfig.rdKey) {
                const isCached = rdCached.includes(t.hash);
                const progress = rdActive[t.hash];
                let name, binge;
                if (isCached || progress === 100) { name = `YOMI [⚡ RD]\n🎥 ${res}`; binge = null; }
                else if (progress !== undefined) { name = `YOMI [⏳ ${progress}% RD]\n🎥 ${res}`; binge = null; }
                else { name = `YOMI [☁️ RD DL]\n🎥 ${res}`; binge = `rd_dl_${t.hash}`; }

                streams.push({
                    name: name,
                    title: streamDescription,
                    // WICHTIG: Episode wird jetzt als Parameter an den Resolver übergeben
                    url: `${process.env.BASE_URL || 'http://127.0.0.1:7000'}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/${requestedEpisode}`,
                    behaviorHints: { notWebReady: true, bingeGroup: binge },
                    _bytes: bytes 
                });
            }

            if (userConfig.tbKey) {
                const isCached = tbCached.includes(t.hash);
                const progress = tbActive[t.hash];
                let name, binge;
                if (isCached || progress === 100) { name = `YOMI [⚡ TB]\n🎥 ${res}`; binge = null; }
                else if (progress !== undefined) { name = `YOMI [⏳ ${progress}% TB]\n🎥 ${res}`; binge = null; }
                else { name = `YOMI [☁️ TB DL]\n🎥 ${res}`; binge = `tb_dl_${t.hash}`; }

                streams.push({
                    name: name,
                    title: streamDescription,
                    // WICHTIG: Episode wird jetzt als Parameter an den Resolver übergeben
                    url: `${process.env.BASE_URL || 'http://127.0.0.1:7000'}/resolve/torbox/${userConfig.tbKey}/${t.hash}/${requestedEpisode}`,
                    behaviorHints: { notWebReady: true, bingeGroup: binge },
                    _bytes: bytes 
                });
            }
        });

        streams.sort((a, b) => {
            const aCached = a.name.includes('⚡');
            const bCached = b.name.includes('⚡');
            if (aCached && !bCached) return -1;
            if (!aCached && bCached) return 1;
            return b._bytes - a._bytes;
        });

        streams.forEach(s => delete s._bytes);
        return { streams: streams, cacheMaxAge: 5 };
    } catch (err) {
        return { streams: [], cacheMaxAge: 60 };
    }
});

module.exports = {
    addonInterface: builder.getInterface(),
    manifest,
    parseConfig
};
