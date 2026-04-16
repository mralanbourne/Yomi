//===============
// YOMI STREMIO ADDON - CORE LOGIC
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getLatestAdultAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchSukebeiForHentai, cleanTorrentTitle } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, verifyTitleMatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7000";
BASE_URL = BASE_URL.replace(/\/+$/, "");

const INTERNAL_TB_KEY = process.env.INTERNAL_TORBOX_KEY || "";

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Safe(str) {
    return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

const manifest = {
    id: "org.community.yomi",
    version: "7.0.0", 
    name: "Yomi",
    logo: BASE_URL + "/yomi.png", 
    description: "The ultimate Debrid-powered Sukebei gateway. Streams raw, uncompressed Hentai & NSFW Anime directly via Real-Debrid or Torbox.",
    types: ["anime", "movie", "series"],
    resources: [
        "catalog",
        {
            name: "meta",
            types: ["anime", "movie", "series"],
            idPrefixes: ["anilist:", "sukebei:"]
        },
        {
            name: "stream",
            types: ["anime", "movie", "series"],
            idPrefixes: ["anilist:", "sukebei:", "kitsu:", "tt"]
        }
    ],
    catalogs: [
        { id: "sukebei_latest", type: "anime", name: "Yomi Latest Releases" },
        { id: "sukebei_trending", type: "anime", name: "Yomi Trending" },
        { id: "sukebei_top", type: "anime", name: "Yomi Top Rated" },
        { id: "sukebei_search", type: "anime", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [
        { key: "Yomi", type: "text", title: "Yomi Internal Payload", required: false }
    ],
    behaviorHints: { configurable: true, configurationRequired: true },
};

const builder = new addonBuilder(manifest);

function parseConfig(config) {
    let parsed = {};
    try {
        if (config && config.Yomi) {
            let b64 = config.Yomi.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) { b64 += "="; } 
            const decoded = Buffer.from(b64, "base64").toString("utf8");
            parsed = JSON.parse(decoded);
        } else {
            parsed = config || {};
        }
    } catch (err) {
        console.error("[Config] PARSING ERROR:", err.message);
    }
    return parsed || {};
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 * 1024 * 1024;
    if (unit.includes("M")) return val * 1024 * 1024;
    if (unit.includes("K")) return val * 1024;
    return val;
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
    return "ENG"; 
}

function sanitizeSearchQuery(title) {
    if (!title) return "";
    return title.replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim();
}

function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all\s+episodes/i.test(title)) return true;
    return isEpisodeMatch(title, requestedEp);
}

function generateDynamicPoster(title) {
    let clean = title.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ");
    let safeTitle = clean.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s{2,}/g, " ").substring(0, 30).trim().toUpperCase();
    let words = safeTitle.split(" ");
    let lines = [];
    let line = "";
    for (let word of words) {
        if ((line + word).length > 10) {
            if (line) lines.push(line.trim());
            line = word + " ";
        } else { line += word + " "; }
    }
    if (line) lines.push(line.trim());
    return "https://dummyimage.com/600x900/1a1a1a/e91e63.png?text=" + encodeURIComponent(lines.join("\n"));
}

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    const userConfig = parseConfig(config);
    if (id === "sukebei_latest") {
        if (userConfig.showLatest === false) return { metas: [] };
        const metas = await getLatestAdultAnime();
        return { metas: metas.map(m => ({ ...m, type: "anime" })), cacheMaxAge: 14400 };
    }
    if (id === "sukebei_trending") {
        if (userConfig.showTrending === false) return { metas: [] };
        const metas = await getTrendingAdultAnime();
        return { metas: metas.map(m => ({ ...m, type: "anime" })), cacheMaxAge: 43200 };
    }
    if (id === "sukebei_top") {
        if (userConfig.showTop === false) return { metas: [] };
        const metas = await getTopAdultAnime();
        return { metas: metas.map(m => ({ ...m, type: "anime" })), cacheMaxAge: 43200 };
    }
    if (id === "sukebei_search" && extra.search) {
        const cleanQuery = sanitizeSearchQuery(extra.search);
        const [anilistMetas, sukebeiTorrents] = await Promise.all([
            searchAdultAnime(extra.search), 
            searchSukebeiForHentai(cleanQuery)
        ]);
        anilistMetas.sort((a, b) => {
            const dateA = a.released ? new Date(a.released).getTime() : Infinity;
            const dateB = b.released ? new Date(b.released).getTime() : Infinity;
            return dateA - dateB;
        });
        const finalMetas = anilistMetas.map(m => {
            m.type = "anime";
            return m;
        });
        const rawGroups = {};
        sukebeiTorrents.forEach(t => {
            const cleanName = cleanTorrentTitle(t.title);
            if (cleanName.length > 2 && !rawGroups[cleanName]) rawGroups[cleanName] = t;
        });
        Object.keys(rawGroups).forEach(cleanName => {
            if (!anilistMetas.some(m => m.name.toLowerCase().includes(cleanName.toLowerCase()))) {
                finalMetas.push({ 
                    id: "sukebei:" + toBase64Safe(cleanName), type: "anime", 
                    name: cleanName.replace(/^\[.*?\]\s*/g, "").trim(), poster: generateDynamicPoster(cleanName) 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
    if (!id.startsWith("anilist:") && !id.startsWith("sukebei:")) return Promise.resolve({ meta: null });
    let meta = null, searchTitle = "";
    try {
        if (id.startsWith("anilist:")) {
            const parts = id.split(":");
            let aniListId = parts[1];
            const rawMeta = await getAnimeMeta(aniListId);
            if (rawMeta) {
                searchTitle = rawMeta.name;
                meta = { ...rawMeta }; 
                meta.id = id; 
            } else {
                meta = { id: id, type: "anime", name: "Unknown", poster: generateDynamicPoster("Unknown"), baseTime: Date.now(), epMeta: {} };
            }
        } else if (id.startsWith("sukebei:")) {
            const parts = id.split(":");
            searchTitle = fromBase64Safe(parts[1]);
            let cleanQuery = searchTitle.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
            const malData = await getJikanMeta(cleanQuery);
            if (malData) {
                meta = { id, type: "anime", name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), poster: malData.poster || generateDynamicPoster(searchTitle), background: malData.background, description: malData.description, releaseInfo: malData.releaseInfo, released: malData.released, episodes: malData.episodes, baseTime: malData.baseTime, epMeta: {} };
            } else {
                meta = { id, type: "anime", name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), poster: generateDynamicPoster(searchTitle), baseTime: Date.now(), epMeta: {} };
            }
        }
        
        meta.type = "anime";
        
        let epCount = meta.episodes || 1;
        if (epCount === 1 || !meta.episodes) {
            try {
                const torrents = await searchSukebeiForHentai(sanitizeSearchQuery(searchTitle));
                let maxDetected = 1;
                torrents.forEach(t => {
                    const batch = getBatchRange(t.title);
                    if (batch && batch.end > maxDetected && batch.end < 50) maxDetected = batch.end;
                    const ext = extractEpisodeNumber(t.title);
                    if (ext && ext > maxDetected && ext < 50) maxDetected = ext;
                });
                if (maxDetected > epCount) epCount = maxDetected;
            } catch(e) {}
        }
        const videos = [];
        const episodeThumbnail = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/e91e63.png?text=YOMI+EPISODE";
        const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal) : {};
        const baseTime = meta.baseTime || Date.now();
        const epMeta = meta.epMeta || {};
        const nextAiring = meta.nextAiringEpisode;
        
        for (let i = 1; i <= epCount; i++) {
            const epData = epMeta[i] || {};
            const jData = jikanEps[i] || {};
            const finalTitle = jData.title || epData.title || ("Episode " + i);
            let finalDate;
            if (jData.aired) { finalDate = new Date(jData.aired).toISOString(); } 
            else if (nextAiring && nextAiring.episode && nextAiring.airingAt) {
                const weeksBehind = nextAiring.episode - i;
                finalDate = new Date((nextAiring.airingAt * 1000) - (weeksBehind * 7 * 24 * 60 * 60 * 1000)).toISOString();
            } else { finalDate = new Date(baseTime + (i - 1) * 7 * 24 * 60 * 60 * 1000).toISOString(); }
            
            videos.push({ id: meta.id + ":" + 1 + ":" + i, title: finalTitle, season: 1, episode: i, released: finalDate, thumbnail: epData.thumbnail || episodeThumbnail });
        }
        meta.videos = videos;
        return { meta, cacheMaxAge: 604800 };
    } catch (err) {
        return { meta: { id, type: "anime", name: "Error", poster: generateDynamicPoster("Error") }, cacheMaxAge: 60 };
    }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    if (!id.startsWith("anilist:") && !id.startsWith("sukebei:") && !id.startsWith("kitsu:") && !id.startsWith("tt")) return Promise.resolve({ streams: [] });
    try {
        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };
        let searchTitle = "", requestedEp = 1, aniListIdForFallback = null;
        
        const parts = id.split(":");

        if (id.startsWith("anilist:")) {
            aniListIdForFallback = parts[1];
            if (parts.length > 2 && isNaN(parts[2]) && parts[2].length > 5) {
                searchTitle = sanitizeSearchQuery(fromBase64Safe(parts[2]));
            } else {
                if (aniListIdForFallback) {
                    const freshMeta = await getAnimeMeta(aniListIdForFallback);
                    if (freshMeta) searchTitle = sanitizeSearchQuery(freshMeta.name);
                }
            }
            requestedEp = parseInt(parts[parts.length - 1], 10) || 1;
        } else if (id.startsWith("sukebei:")) {
            let payload = parts[1];
            searchTitle = sanitizeSearchQuery(fromBase64Safe(payload));
            requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
        } else if (id.startsWith("kitsu:")) {
            try {
                const res = await axios.get(`https://anime-kitsu.strem.fun/meta/anime/${parts[0] + ":" + parts[1]}.json`, { timeout: 4000 });
                searchTitle = sanitizeSearchQuery(res.data?.meta?.name || "");
            } catch (e) {}
            requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
        } else if (id.startsWith("tt")) {
            let res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`, { timeout: 4000 }).catch(() => null);
            searchTitle = sanitizeSearchQuery(res?.data?.meta?.name || "");
            requestedEp = parts.length > 2 ? parseInt(parts[2], 10) : 1;
        }

        if (!searchTitle) return { streams: [] };
        let validSearchTitles = [searchTitle];
        let torrents = await searchSukebeiForHentai(searchTitle);
        
        if (!torrents.length) {
            console.log("[Stream] Engaging Universal Fallback Engine...");
            let fallbackMeta = aniListIdForFallback ? await getAnimeMeta(aniListIdForFallback) : null;
            if (fallbackMeta) {
                const fallbackTitles = new Set();
                if (fallbackMeta.altName && fallbackMeta.altName.length > 2) fallbackTitles.add(fallbackMeta.altName);
                if (fallbackMeta.synonyms) fallbackMeta.synonyms.forEach(syn => { if (/^[a-zA-Z0-9\s\-_!:]+$/.test(syn)) fallbackTitles.add(syn); });
                
                const primaryWords = searchTitle.split(/\s+/);
                
                if (primaryWords.length >= 2) fallbackTitles.add(primaryWords.slice(0, 2).join(" "));
                if (primaryWords.length > 3) fallbackTitles.add(primaryWords.slice(0, 3).join(" "));
                if (primaryWords.length > 4) fallbackTitles.add(primaryWords.slice(0, 4).join(" "));
                
                if (primaryWords.length > 1) {
                    fallbackTitles.add(primaryWords.slice(0, -1).join(" "));
                }

                if (primaryWords.length > 1 && primaryWords[0].length >= 4) {
                    fallbackTitles.add(primaryWords[0]);
                }

                if (fallbackMeta.altName) {
                    const altWords = fallbackMeta.altName.split(/\s+/);
                    if (altWords.length > 3) fallbackTitles.add(altWords.slice(0, 3).join(" "));
                    if (altWords.length > 1) fallbackTitles.add(altWords.slice(0, -1).join(" "));
                    if (altWords.length > 1 && altWords[0].length >= 4) fallbackTitles.add(altWords[0]);
                }

                for (const altTitle of fallbackTitles) {
                    validSearchTitles.push(altTitle);
                    torrents = await searchSukebeiForHentai(sanitizeSearchQuery(altTitle));
                    if (torrents.length > 0) break;
                }
            }
        }
        torrents = torrents.filter(t => verifyTitleMatch(t.title, validSearchTitles));
        if (!torrents.length) return { streams: [], cacheMaxAge: 60 };
        const hashes = torrents.map(t => t.hash);
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            (userConfig.tbKey || INTERNAL_TB_KEY) ? checkTorbox(hashes, userConfig.tbKey || INTERNAL_TB_KEY).catch(() => ({})) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {}
        ]);
        const userLangs = Array.isArray(userConfig.language) ? userConfig.language : [userConfig.language || "ENG"];
        const streams = [];
        const flags = { "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" };

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const filesRD = rdC[hashLow]; const progRD = rdA[hashLow];
            const filesTB = tbC[hashLow]; const progTB = tbA[hashLow];
            const streamLang = extractLanguage(t.title, userLangs);
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            if (userConfig.rdKey) {
                let matchedFile = filesRD ? selectBestVideoFile(filesRD, requestedEp) : null;
                const isCached = matchedFile || progRD === 100;
                const streamStatus = isCached ? "⚡ Cached" : (progRD !== undefined ? `⏳ ${progRD}% Downloading` : "☁️ Download");
                if (isCached || progRD < 100 || isTitleMatchingEpisode(t.title, requestedEp)) {
                    streams.push({ name: `YOMI [${isCached ? '⚡' : (progRD !== undefined ? '⏳' : '☁️')}] RD\n🎥 ${res}`, description: `${flags[streamLang] || "🇬🇧"} | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { bingeGroup: (isCached ? "rd_" : "dl_") + t.hash, notWebReady: !isCached }, _bytes: bytes, _lang: streamLang, _isCached: isCached, _res: res, _prog: progRD || 0 });
                }
            }
            if (userConfig.tbKey) {
                let matchedFile = filesTB ? selectBestVideoFile(filesTB, requestedEp) : null;
                const isCached = matchedFile || progTB === 100;
                const streamStatus = isCached ? "⚡ Cached" : (progTB !== undefined ? `⏳ ${progTB}% Downloading` : "☁️ Download");
                if (isCached || progTB < 100 || isTitleMatchingEpisode(t.title, requestedEp)) {
                    streams.push({ name: `YOMI [${isCached ? '⚡' : (progTB !== undefined ? '⏳' : '☁️')}] TB\n🎥 ${res}`, description: `${flags[streamLang] || "🇬🇧"} | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { bingeGroup: (isCached ? "tb_" : "dl_") + t.hash, notWebReady: !isCached }, _bytes: bytes, _lang: streamLang, _isCached: isCached, _res: res, _prog: progTB || 0 });
                }
            }
        });


        const searchWords = searchTitle.toLowerCase().split(/\s+/);

        return { streams: streams.sort((a, b) => { 
            const aText = a.description.toLowerCase();
            const bText = b.description.toLowerCase();
            const aExact = searchWords.every(w => aText.includes(w)) ? 1 : 0;
            const bExact = searchWords.every(w => bText.includes(w)) ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;

            if (a._prog > b._prog) return -1; 
            
            if (a._isCached !== b._isCached) return b._isCached ? 1 : -1; 
            
            if (a._lang !== b._lang) { 
                const sA = userLangs.indexOf(a._lang); 
                const sB = userLangs.indexOf(b._lang); 
                if (sA !== -1 && sB !== -1) return sA - sB; 
                if (sA !== -1) return -1; 
                if (sB !== -1) return 1; 
            } 
            
            return b._bytes - a._bytes; 
        }), cacheMaxAge: 3600 };
    } catch (err) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
