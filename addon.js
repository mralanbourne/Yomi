const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "1.0.0",
    name: "Yomi",
    // Replace with your production domain (e.g., https://yomi.koyeb.app/yomi.png) after deployment
    logo: "http://127.0.0.1:7000/yomi.png", 
    description: "The Forbidden Gateway to Sukebei",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [{ 
        type: "movie", 
        id: "sukebei_search", 
        name: "Yomi Search", 
        extra: [{ name: "search", isRequired: true }] 
    }],
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

// --- CATALOG HANDLER ---
builder.defineCatalogHandler(async ({ id, extra }) => {
    console.log(`[CATALOG] Search query: "${extra.search}"`);
    if (id === "sukebei_search" && extra.search) {
        
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
                
                // Bold pink placeholder design for Raw SKB results
                const placeholderUrl = "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ASUKEBEI%0ARESULT";
                
                finalMetas.push({
                    id: `sukebei:${base64Title}`,
                    type: 'movie',
                    name: cleanName,
                    poster: placeholderUrl,
                    description: "Direct search result from the Sukebei network (No AniList metadata)."
                });
            }
        }

        return { metas: finalMetas, cacheMaxAge: 604800 };
    }
    return { metas: [] };
});

// --- META HANDLER ---
builder.defineMetaHandler(async ({ id }) => {
    if (id.startsWith('anilist:')) {
        const anilistId = id.split(':')[1]; 
        const meta = await getAnimeMeta(anilistId);
        if (meta) return { meta: meta, cacheMaxAge: 604800 };
    } 
    else if (id.startsWith('sukebei:')) {
        const base64Title = id.split(':')[1];
        const cleanName = Buffer.from(base64Title, 'base64url').toString('utf8');
        const placeholderUrl = "https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=RAW%0ASUKEBEI%0ARESULT";
        
        return { 
            meta: {
                id: id,
                type: 'movie',
                name: cleanName,
                poster: placeholderUrl,
                description: "Direct search result from the Sukebei network (No AniList metadata)."
            }, 
            cacheMaxAge: 604800 
        };
    }
    
    return { meta: { id: id, type: "movie", name: "Not found" } }; 
});

// --- STREAM HANDLER ---
builder.defineStreamHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

    try {
        let searchTitle = "";

        if (id.startsWith('anilist:')) {
            const idParts = id.split(':');
            if (idParts.length < 3) return { streams: [] };
            searchTitle = Buffer.from(idParts[2], 'base64url').toString('utf8');
        } else if (id.startsWith('sukebei:')) {
            const idParts = id.split(':');
            if (idParts.length < 2) return { streams: [] };
            searchTitle = Buffer.from(idParts[1], 'base64url').toString('utf8');
        } else {
            return { streams: [] };
        }

        console.log(`[STREAM] Searching Sukebei for: "${searchTitle}"`);
        const torrents = await searchSukebeiForHentai(searchTitle);
        if (torrents.length === 0) return { streams: [], cacheMaxAge: 3600 };

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
            const streamTitle = `💾 ${t.size}  |  👤 ${t.seeders}  |  🗣️ ${lang}\n📄 ${t.title}`;

            if (userConfig.rdKey) {
                const isCached = rdCached.includes(t.hash);
                const progress = rdActive[t.hash];
                
                let name, binge;
                if (isCached) {
                    name = `[⚡ RD] ${res}`;
                    binge = null;
                } else if (progress !== undefined) {
                    name = `[⏳ ${progress}%] RD ${res}`;
                    binge = null; 
                } else {
                    name = `[☁️ DL] RD ${res}`;
                    binge = `rd_dl_${t.hash}`;
                }

                streams.push({
                    name: name,
                    title: streamTitle,
                    url: `http://127.0.0.1:7000/resolve/realdebrid/${userConfig.rdKey}/${t.hash}`,
                    behaviorHints: { notWebReady: true, bingeGroup: binge },
                    _bytes: bytes 
                });
            }

            if (userConfig.tbKey) {
                const isCached = tbCached.includes(t.hash);
                const progress = tbActive[t.hash];
                
                let name, binge;
                if (isCached) {
                    name = `[⚡ TB] ${res}`;
                    binge = null;
                } else if (progress !== undefined) {
                    name = `[⏳ ${progress}%] TB ${res}`;
                    binge = null;
                } else {
                    name = `[☁️ DL] TB ${res}`;
                    binge = `tb_dl_${t.hash}`;
                }

                streams.push({
                    name: name,
                    title: streamTitle,
                    url: `http://127.0.0.1:7000/resolve/torbox/${userConfig.tbKey}/${t.hash}`,
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

            const aProg = a.name.includes('⏳');
            const bProg = b.name.includes('⏳');
            if (aProg && !bProg) return -1;
            if (!aProg && bProg) return 1;

            return b._bytes - a._bytes;
        });

        streams.forEach(s => delete s._bytes);

        return { streams: streams, cacheMaxAge: 5 };
    } catch (err) {
        console.error("[STREAM ERROR]", err.message);
        return { streams: [] };
    }
});

module.exports = builder.getInterface();