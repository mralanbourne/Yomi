//===============
// YOMI STREMIO ADDON - CORE LOGIC
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getAiringAnime, getSeasonalAnime, fetchEpisodeDetails } = require("./lib/anilist");
const { searchSukebei, cleanTorrentTitle } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { selectBestVideoFile } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7000";
BASE_URL = BASE_URL.replace(/\/+$/, "");

const INTERNAL_TB_KEY = process.env.INTERNAL_TORBOX_KEY || "";

//===============
// HELPERS
//===============
function toBase64Safe(str) { 
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); 
}

function fromBase64Safe(str) { 
    try { return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } 
    catch (e) { return ""; } 
}

function parseConfig(config) {
    let parsed = {};
    try { 
        if (config && config.Yomi) { 
            const decoded = Buffer.from(config.Yomi.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); 
            parsed = JSON.parse(decoded); 
        } else { parsed = config || {}; } 
    } catch (e) {}
    return parsed;
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]); 
    const unit = match[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 * 1024 * 1024;
    if (unit.includes("M")) return val * 1024 * 1024;
    return val * 1024;
}

function extractTags(title) {
    let res = "SD";
    if (/(4320p|8k|FUHD)/i.test(title)) res = "8K";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    else if (/(1440p|2k|QHD)/i.test(title)) res = "2K";
    else if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    return { res };
}

const manifest = {
    "id": "org.community.yomi", 
    "version": "8.2.5", 
    "name": "Yomi", 
    "logo": BASE_URL + "/yomi.png",
    "description": "Debrid-powered Gateway for Sukebei. Fast Search for Adult Content.",
    "types": ["anime", "movie", "series"],
    "resources": [
        "catalog",
        { "name": "meta", "types": ["anime", "movie", "series"], "idPrefixes": ["anilist:", "yomi_raw:", "tt"] },
        { "name": "stream", "types": ["anime", "movie", "series"], "idPrefixes": ["anilist:", "yomi_raw:", "tt"] }
    ],
    "catalogs": [
        { 
            "id": "yomi_search", 
            "type": "anime", 
            "name": "Yomi Search", 
            "extra": [{ "name": "search", "isRequired": true }] 
        },
        { 
            "id": "yomi_search", 
            "type": "movie", 
            "name": "Yomi Search", 
            "extra": [{ "name": "search", "isRequired": true }] 
        }
    ],
    "config": [{ "key": "Yomi", "type": "text", "title": "Yomi Internal Payload" }],
    "behaviorHints": { "configurable": true, "configurationRequired": true }
};

const builder = new addonBuilder(manifest);

//===============
// CATALOG HANDLER
//===============
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id !== "yomi_search" || !extra.search) return { metas: [] };

    console.log(`[YOMI] Catalog search triggered: ${extra.search}`);

    try {
        const anilistPromise = searchAnime(extra.search).catch(() => []);
        const cinemetaUrl = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(extra.search)}.json`;
        const cinemetaPromise = axios.get(cinemetaUrl, { timeout: 5000 }).then(res => res.data.metas || []).catch(() => []);
        
        // Sukebei-Check
        const sukebeiPromise = searchSukebei(extra.search).catch(() => []);

        const [anilistRes, cinemetaRes, sukebeiRes] = await Promise.all([
            anilistPromise,
            cinemetaPromise,
            sukebeiPromise
        ]);

        const results = [];
        const seenIds = new Set();

        // 1. AniList
        anilistRes.filter(m => m.type === type).forEach(m => {
            if (!seenIds.has(m.id)) {
                results.push(m);
                seenIds.add(m.id);
            }
        });

        // 2. Cinemeta
        cinemetaRes.forEach(m => {
            if (!seenIds.has(m.id)) {
                results.push(m);
                seenIds.add(m.id);
            }
        });

        // 3. Raw Search
        if (results.length < 5) {
            results.push({
                "id": `yomi_raw:${type}:${toBase64Safe(extra.search)}`,
                "type": type,
                "name": `RAW: ${extra.search}`,
                "poster": `https://dummyimage.com/600x900/1a1a1a/e53935.png?text=${encodeURIComponent(extra.search)}`,
                "description": `Direkte Sukebei-Suche für "${extra.search}". Nutze dies, wenn kein Poster passt.`
            });
        }

        return { metas: results };
    } catch (e) {
        console.error("[YOMI] Catalog Error:", e.message);
        return { metas: [] };
    }
});

//===============
// META HANDLER
//===============
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (id.startsWith("tt")) {
            const imdbId = id.split(":")[0];
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
            return { meta: res.data.meta, cacheMaxAge: 604800 };
        }

        if (id.startsWith("yomi_raw:")) {
            const parts = id.split(":");
            const query = fromBase64Safe(parts[2]);
            return {
                meta: {
                    id: id,
                    type: parts[1],
                    name: query + " (Raw Search)",
                    poster: `https://dummyimage.com/600x900/1a1a1a/e53935.png?text=${encodeURIComponent(query)}`,
                    description: `Manuelle Suche auf Sukebei nach "${query}".`,
                    videos: Array.from({ length: 1 }, (_, i) => ({
                        id: `${id}-1`,
                        title: `Full Content`,
                        season: 1,
                        episode: 1
                    }))
                }
            };
        }

        if (id.startsWith("anilist:")) {
            const aniListId = id.split(":")[1];
            const meta = await getAnimeMeta(aniListId);
            if (meta) {
                meta.id = id;
                return { meta, cacheMaxAge: 604800 };
            }
        }
        return { meta: null };
    } catch (e) { return { meta: null }; }
});

//===============
// STREAM HANDLER
//===============
builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

        let query = "";
        if (id.startsWith("yomi_raw:")) {
            query = fromBase64Safe(id.split(":")[2]);
        } else if (id.startsWith("anilist:")) {
            const meta = await getAnimeMeta(id.split(":")[1]);
            query = meta ? meta.name : "";
        } else if (id.startsWith("tt")) {
            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${id.split(":")[0]}.json`);
            query = res.data.meta ? res.data.meta.name : "";
        }

        if (!query) return { streams: [] };

        const torrents = await searchSukebei(query);
        const hashes = torrents.map(t => t.hash);
        
        const [rdC, tbC] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {}
        ]);

        const streams = [];
        torrents.forEach(t => {
            const { res } = extractTags(t.title);
            const isCachedRD = rdC[t.hash] && rdC[t.hash].length > 0;
            const isCachedTB = tbC[t.hash] && tbC[t.hash].length > 0;

            if (isCachedRD) {
                streams.push({
                    name: `YOMI [⚡ RD]\n${res}`,
                    description: `📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders} Seeds`,
                    url: `${BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/1`
                });
            }
            if (isCachedTB) {
                streams.push({
                    name: `YOMI [⚡ TB]\n${res}`,
                    description: `📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders} Seeds`,
                    url: `${BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/1`
                });
            }
        });

        return { streams };
    } catch (e) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest };
