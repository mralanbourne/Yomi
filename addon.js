//===============
// YOMI STREMIO ADDON - CORE LOGIC
// (Historical Koyeb Base + Subtitle Injector)
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getAiringAnime, getSeasonalAnime, fetchEpisodeDetails } = require("./lib/anilist");
const { searchSukebei, cleanTorrentTitle } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7000";
BASE_URL = BASE_URL.replace(/\/+$/, "");

const INTERNAL_TB_KEY = process.env.INTERNAL_TORBOX_KEY || "";

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
        } else { 
            parsed = config || {}; 
        } 
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
    else if (/(480p|480)/i.test(title)) res = "480p";
    return { res };
}

const LANG_REGEX = {
    "GER": /\b(ger|deu|german|deutsch|de-de)\b|(?:^|\[|\()(de)(?:\]|\)|$)/i,
    "FRE": /\b(fre|fra|french|vostfr|vf|fr-fr)\b|(?:^|\[|\()(fr)(?:\]|\)|$)/i,
    "ITA": /\b(ita|italian|it-it)\b|(?:^|\[|\()(it)(?:\]|\)|$)/i,
    "SPA": /\b(spa|esp|spanish|es-es|es-mx)\b|(?:^|\[|\()(es)(?:\]|\)|$)/i,
    "RUS": /\b(rus|russian|ru-ru)\b|(?:^|\[|\()(ru)(?:\]|\)|$)/i,
    "POR": /\b(por|pt-br|portuguese|pt-pt)\b|(?:^|\[|\()(pt)(?:\]|\)|$)/i,
    "ARA": /\b(ara|arabic|ar-sa)\b|(?:^|\[|\()(ar)(?:\]|\)|$)/i,
    "CHI": /\b(chi|chinese|chs|cht|mandarin|zh-cn|zh-tw)\b|(?:^|\[|\()(zh)(?:\]|\)|$)|(简|繁|中文字幕)/i,
    "KOR": /\b(kor|korean|ko-kr)\b|(?:^|\[|\()(ko)(?:\]|\)|$)/i,
    "HIN": /\b(hin|hindi|hi-in)\b|(?:^|\[|\()(hi)(?:\]|\)|$)/i,
    "POL": /\b(pol|polish|pl-pl)\b|(?:^|\[|\()(pl)(?:\]|\)|$)/i,
    "NLD": /\b(nld|dut|dutch|nl-nl)\b|(?:^|\[|\()(nl)(?:\]|\)|$)/i,
    "TUR": /\b(tur|turkish|tr-tr)\b|(?:^|\[|\()(tr)(?:\]|\)|$)/i,
    "VIE": /\b(vie|vietnamese|vi-vn)\b|(?:^|\[|\()(vi)(?:\]|\)|$)/i,
    "IND": /\b(ind|indonesian|id-id)\b|(?:^|\[|\()(id)(?:\]|\)|$)/i,
    "ENG": /\b(eng|english|dubbed|subbed|en-us|en-gb)\b|(?:^|\[|\()(en)(?:\]|\)|$)/i,
    "JPN": /\b(jpn|japanese|raw|jp-jp)\b|(?:^|\[|\()(jp)(?:\]|\)|$)/i,
    "MULTI": /(multi|dual|multi-audio|multi-sub)/i
};

function extractLanguage(title, userLangs = []) {
    const lower = title.toLowerCase();
    for (let lang of userLangs) {
        if (LANG_REGEX[lang] && LANG_REGEX[lang].test(lower)) return lang;
    }
    if (LANG_REGEX["MULTI"].test(lower)) return "MULTI";
    if (LANG_REGEX["ENG"].test(lower)) return "ENG";
    if (LANG_REGEX["JPN"].test(lower)) return "JPN";
    return "JPN"; 
}

function sanitizeSearchQuery(title) { 
    if (!title) return "";
    return title.replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim(); 
}

const manifest = {
    "id": "org.community.yomi", "version": "8.2.1", "name": "Yomi", "logo": BASE_URL + "/yomi.png",
    "description": "The ultimate Debrid-powered Gateway for Sukebei. Parallel Search for Adult Content.",
    "types": ["anime", "movie", "series"],
    "resources": [
        "catalog",
        { "name": "meta", "types": ["anime", "movie", "series"], "idPrefixes": ["anilist:", "yomi_raw:", "tt"] },
        { "name": "stream", "types": ["anime", "movie", "series"], "idPrefixes": ["anilist:", "yomi_raw:", "tt"] }
    ],
    "catalogs": [
        { "id": "yomi_search", "type": "anime", "name": "Yomi Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "yomi_search", "type": "movie", "name": "Yomi Search", "extra": [{ "name": "search", "isRequired": true }] }
    ],
    "config": [{ "key": "Yomi", "type": "text", "title": "Yomi Internal Payload" }],
    "behaviorHints": { "configurable": true, "configurationRequired": true }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        if (id === "yomi_search" && extra.search) {
            const sukebeiPromise = searchSukebei(extra.search).catch(() => []);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3500));

            const [anilistRes, cinemetaRes, sukebeiRes] = await Promise.all([
                searchAnime(extra.search).catch(() => []),
                axios.get(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(extra.search)}.json`, { timeout: 4000 }).then(res => res.data.metas || []).catch(() => []),
                Promise.race([sukebeiPromise, timeoutPromise])
            ]);

            const results = [];
            const seenIds = new Set();

            anilistRes.filter(m => m.type === type).forEach(m => {
                results.push(m);
                seenIds.add(m.id);
            });

            cinemetaRes.forEach(m => {
                if (!seenIds.has(m.id)) {
                    results.push(m);
                    seenIds.add(m.id);
                }
            });

            if (results.length < 2 && sukebeiRes.length > 0) {
                results.push({
                    "id": `yomi_raw:${type}:${toBase64Safe(extra.search)}`,
                    "type": type,
                    "name": extra.search + " (RAW SEARCH)",
                    "poster": `https://dummyimage.com/600x900/1a1a1a/e53935.png?text=${encodeURIComponent(extra.search)}\nRaw+Search`,
                    "background": `https://dummyimage.com/1920x1080/1a1a1a/e53935.png?text=${encodeURIComponent(extra.search)}`,
                    "description": `Found ${sukebeiRes.length} raw torrents on Sukebei.`
                });
            }

            if (results.length === 0) {
                results.push({
                    "id": `yomi_raw:${type}:${toBase64Safe(extra.search)}`,
                    "type": type,
                    "name": extra.search + " (RAW SEARCH)",
                    "poster": `https://dummyimage.com/600x900/1a1a1a/e53935.png?text=${encodeURIComponent(extra.search)}\nRaw+Search`,
                    "background": `https://dummyimage.com/1920x1080/1a1a1a/e53935.png?text=${encodeURIComponent(extra.search)}`,
                    "description": `Search Sukebei directly for "${extra.search}".`
                });
            }

            return { "metas": results, "cacheMaxAge": 86400 };
        }
        return { "metas": [] };
    } catch (e) { return { "metas": [] }; }
});

builder.defineMetaHandler(async ({ type, id }) => {
    try {
        if (id.startsWith("tt")) {
            const imdbId = id.split(":")[0];
            const reqType = type || "movie";
            let metaData = null;
            try {
                const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${reqType}/${imdbId}.json`, { timeout: 4000 });
                metaData = res.data?.meta;
            } catch (e) {}

            if (!metaData) {
                metaData = {
                    id: imdbId, type: reqType, name: "Unknown Title", 
                    description: "Metadata could not be loaded. Streams may still be available.",
                    poster: "https://dummyimage.com/600x900/1a1a1a/e53935.png?text=NO+META"
                };
            }
            return { "meta": metaData, "cacheMaxAge": 604800 };
        }

        if (id.startsWith("yomi_raw:")) {
            const parts = id.split(":");
            const mType = parts[1];
            const query = fromBase64Safe(parts[2]);
            const meta = {
                "id": id, "type": mType, "name": query + " (Raw Search)",
                "poster": `https://dummyimage.com/600x900/1a1a1a/e53935.png?text=${encodeURIComponent(query)}\nRaw+Search`,
                "background": `https://dummyimage.com/1920x1080/1a1a1a/e53935.png?text=${encodeURIComponent(query)}`,
                "description": `Dynamically generated metadata for Sukebei search "${query}".`,
            };
            if (mType === "series" || mType === "anime") {
                meta.videos = [];
                for (let s = 1; s <= 10; s++) {
                    for (let e = 1; e <= 100; e++) {
                        meta.videos.push({ "id": `${id}-${e}`, "title": `Episode ${e}`, "season": s, "episode": e });
                    }
                }
            }
            return { "meta": meta, "cacheMaxAge": 86400 };
        }

        if (!id.startsWith("anilist:")) return { "meta": null };
        const aniListId = id.split(":")[1];
        if (!aniListId || isNaN(aniListId)) return { "meta": null };
        const meta = await getAnimeMeta(aniListId);
        if (!meta) return { "meta": null };
        
        meta.id = id;

        if (meta.type === "anime" || meta.type === "series") {
            meta.type = "anime";
            const epMeta = meta.epMeta || {};
            const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/e53935.png?text=YOMI+EPISODE";
            meta.videos = Array.from({ "length": meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const epData = epMeta[epNum] || {};
                return { "id": `${id}-${epNum}`, "title": epData.title || `Episode ${epNum}`, "season": 1, "episode": epNum, "thumbnail": epData.thumbnail || defaultThumb };
            });
        }
        return { "meta": meta, "cacheMaxAge": 604800 };
    } catch (e) { return { "meta": null }; }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        if (!id.startsWith("anilist:") && !id.startsWith("tt") && !id.startsWith("yomi_raw:")) return { "streams": [] };

        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { "streams": [] };

        let aniListId = null;
        let searchTitleFallback = null;
        let requestedEp = 1;
        let expectedSeason = 1;
        let isRawSearch = false;

        const parts = id.split(":");

        if (id.startsWith("yomi_raw:")) {
            let rawPayload = parts[2];
            if (rawPayload && rawPayload.includes("-")) {
                let subParts = rawPayload.split("-");
                searchTitleFallback = fromBase64Safe(subParts[0]);
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                searchTitleFallback = fromBase64Safe(rawPayload);
            }
            isRawSearch = true;
        } else if (id.startsWith("anilist:")) {
            let payload = parts[1];
            if (payload.includes("-")) {
                let subParts = payload.split("-");
                aniListId = subParts[0];
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                aniListId = payload;
                requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
            }
        } else if (id.startsWith("tt")) {
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            }
        }

        const metaTasks = [];
        if (id.startsWith("tt")) {
            metaTasks.push((async () => {
                const imdbId = parts[0];
                let name = "";
                try {
                    let res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 4000 });
                    name = res.data?.meta?.name;
                } catch(e) {}
                return { source: "cinemeta", name: name || "" };
            })());
        }
        if (aniListId) {
            metaTasks.push(getAnimeMeta(aniListId).then(meta => ({ "source": "anilist", "meta": meta })).catch(() => null));
        }

        const metaResults = await Promise.all(metaTasks);
        let freshMeta = null;
        metaResults.forEach(r => {
            if (!r) return;
            if (r.source === "cinemeta") searchTitleFallback = r.name;
            if (r.source === "anilist") freshMeta = r.meta;
        });

        if (!freshMeta && !searchTitleFallback) return { "streams": [] };

        const isMovie = type === "movie" || (freshMeta && freshMeta.format === "MOVIE");

        const titleList = [];
        if (searchTitleFallback) titleList.push(sanitizeSearchQuery(searchTitleFallback));
        if (freshMeta) {
            if (freshMeta.name) titleList.push(sanitizeSearchQuery(freshMeta.name));
            if (freshMeta.altName) titleList.push(sanitizeSearchQuery(freshMeta.altName));
        }

        const uniqueTitles = [...new Set(titleList.filter(Boolean))];
        let torrents = [];

        for (const title of uniqueTitles) {
            const t = await searchSukebei(title);
            torrents = [...torrents, ...t];
        }

        const uniqueTorrents = new Map();
        torrents.forEach(t => {
            if (!uniqueTorrents.has(t.hash)) uniqueTorrents.set(t.hash, t);
        });
        torrents = Array.from(uniqueTorrents.values());

        if (!torrents.length) return { "streams": [], "cacheMaxAge": 60 };

        const hashes = torrents.map(t => t.hash.toLowerCase());
        
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            (userConfig.tbKey || INTERNAL_TB_KEY) ? checkTorbox(hashes, userConfig.tbKey || INTERNAL_TB_KEY).catch(() => ({})) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {}
        ]);

        const flags = { "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" };
        const userLangs = Array.isArray(userConfig.language) ? userConfig.language : [userConfig.language || "ENG"];

        const streams = [];

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            const streamLang = extractLanguage(t.title, userLangs);
            const flag = flags[streamLang] || "🇯🇵";

            let isValidMatch = true; 

            // ===============
            // REAL-DEBRID LOGIC (Inkl. Subtitles)
            // ===============
            if (userConfig.rdKey) {
                const files = rdC[hashLow];
                const prog = rdA[hashLow];
                
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason, isMovie) : null;
                const isCached = !!matchedFile;
                const isDownloading = prog !== undefined && prog < 100;

                let uiName = `YOMI [☁️ RD]`;
                let streamStatus = "☁️ Download";

                if (isCached) {
                    uiName = `YOMI [⚡ RD]`;
                    streamStatus = "⚡ Cached";
                } else if (isDownloading) {
                    uiName = `YOMI [⏳ ${prog}% RD]`;
                    streamStatus = `⏳ ${prog}% Downloading`;
                }

                let subtitles = [];
                if (isCached && files) {
                    const subFiles = files.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                    subFiles.forEach(sub => {
                        subtitles.push({
                            id: String(sub.id),
                            url: `${BASE_URL}/sub/realdebrid/${userConfig.rdKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                            lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                        });
                    });
                }

                if (isCached || isDownloading || isValidMatch) {
                    const streamPayload = {
                        "name": uiName + `\n🎥 ${res}`,
                        "description": `${flag} Sukebei | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeds`,
                        "url": BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "yomi_rd_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isCached, "_res": res, "_prog": prog || 0
                    };
                    if (subtitles.length > 0) streamPayload.subtitles = subtitles;
                    streams.push(streamPayload);
                }
            }

            // ===============
            // TORBOX LOGIC (Inkl. Subtitles)
            // ===============
            if (userConfig.tbKey) {
                const files = tbC[hashLow];
                const prog = tbA[hashLow];
                
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason, isMovie) : null;
                const isCached = !!matchedFile;
                const isDownloading = prog !== undefined && prog < 100;

                let uiName = `YOMI [☁️ TB]`;
                let streamStatus = "☁️ Download";

                if (isCached) {
                    uiName = `YOMI [⚡ TB]`;
                    streamStatus = "⚡ Cached";
                } else if (isDownloading) {
                    uiName = `YOMI [⏳ ${prog}% TB]`;
                    streamStatus = `⏳ ${prog}% Downloading`;
                }

                let subtitles = [];
                if (isCached && files) {
                    const subFiles = files.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                    subFiles.forEach(sub => {
                        subtitles.push({
                            id: String(sub.id),
                            url: `${BASE_URL}/sub/torbox/${userConfig.tbKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                            lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                        });
                    });
                }

                if (isCached || isDownloading || isValidMatch) {
                    const streamPayload = {
                        "name": uiName + `\n🎥 ${res}`,
                        "description": `${flag} Sukebei | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeds`,
                        "url": BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "yomi_tb_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isCached, "_res": res, "_prog": prog || 0
                    };
                    if (subtitles.length > 0) streamPayload.subtitles = subtitles;
                    streams.push(streamPayload);
                }
            }
        });

        return { 
            "streams": streams.sort((a, b) => {
                if (a._prog > 0 && b._prog === 0) return -1;
                if (b._prog > 0 && a._prog === 0) return 1;
                if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;
                return b._bytes - a._bytes;
            }), 
            "cacheMaxAge": 3600 
        };
    } catch (err) { 
        return { "streams": [] }; 
    }
});

module.exports = { "addonInterface": builder.getInterface(), manifest, parseConfig };
