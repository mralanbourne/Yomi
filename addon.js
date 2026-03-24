const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "1.3.0",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "Ultra-Smart Content-Aware Gateway. Dynamic Episode Lists & Subtitle Proxying.",
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

// Helfer: Erkennt Episodennummern in Dateinamen
function parseEpisodeNumber(filename) {
    const match = filename.match(/[EePp._\s\-\[](\d{1,3})\b/);
    return match ? parseInt(match[1]) : null;
}

builder.defineMetaHandler(async ({ id, config }) => {
    const userConfig = parseConfig(config);
    let meta = null;

    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        meta = await getAnimeMeta(parts[1]);
        if (!meta) meta = { id, type: 'series', name: Buffer.from(parts[2], 'base64url').toString('utf8'), episodes: 24 };
    } else if (id.startsWith('sukebei:')) {
        const title = Buffer.from(id.split(':')[1], 'base64url').toString('utf8');
        meta = { id, type: 'series', name: title, episodes: 24 };
    }

    if (meta && meta.type === 'series') {
        const videos = [];
        // Wir bieten standardmäßig 24 Slots an, der Resolver übernimmt das feine Mapping.
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
    
    // Parse Requested Content
    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        searchTitle = Buffer.from(parts[2], 'base64url').toString('utf8').replace(/\(.*?\)/g, '').trim();
        if (parts.length >= 5) requestedEp = parseInt(parts[4]);
    } else if (id.startsWith('sukebei:')) {
        searchTitle = Buffer.from(id.split(':')[1], 'base64url').toString('utf8');
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
        
        // Subtitle Finder Proxy
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

            // Smart Title: Wenn im Cache, zeige den echten Dateinamen für diese Episode
            let displayTitle = descBase + `\n📄 ${t.title}`;
            if (files) {
                const epPadded = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
                const epRegex = new RegExp(`[EePp._\\s\\-\\[]${requestedEp}\\b|\\b${epPadded}\\b`, 'i');
                const match = files.find(f => /\.(mkv|mp4|avi)$/i.test(f.name) && epRegex.test(f.name));
                if (match) displayTitle = descBase + `\n🎯 Detected: ${match.name}`;
            }

            streams.push({
                name,
                title: displayTitle,
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
