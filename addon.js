//===============
// YOMI STREMIO ADDON - CORE LOGIC
// (Clean Architecture + Fixed Episode Parsing + Strict Episode Enforcing + Dynamic Meta Extension)
// Inklusive Anime Offline Database (AOD) Auto-Alias Integration.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getLatestAdultAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchSukebeiForHentai, cleanTorrentTitle } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch } = require("./lib/parser");
const { getAliasesByAniListId, getAliasesByTitle } = require("./lib/aod");

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
    version: "9.0.0", 
    name: "Yomi",
    logo: BASE_URL + "/yomi.png", 
    description: "The ultimate Debrid-powered Sukebei gateway. Streams raw, uncompressed Hentai & NSFW Anime directly via Real-Debrid or Torbox.",
    types: ["anime", "movie", "series"],
    resources: [
        "catalog",
        { name: "meta", types: ["anime", "movie", "series"], idPrefixes: ["anilist:", "sukebei:"] },
        { name: "stream", types: ["anime", "movie", "series"], idPrefixes: ["anilist:", "sukebei:", "kitsu:", "tt"] }
    ],
    catalogs: [
        { id: "sukebei_latest", type: "anime", name: "Yomi Latest Releases" },
        { id: "sukebei_trending", type: "anime", name: "Yomi Trending" },
        { id: "sukebei_top", type: "anime", name: "Yomi Top Rated" },
        { id: "sukebei_search", type: "anime", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "Yomi", type: "text", title: "Yomi Internal Payload", required: false }],
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
    } catch (err) {}
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
    "ITA": /\b(ita|italian|it-it)\b|(?:^|\[|\()(it)(it)(?:\]|\)|$)/i,
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

function yomiIsEpisodeMatch(title, requestedEp, expectedSeason) {
    if (isSeasonBatch(title, expectedSeason)) return true;
    if (isEpisodeMatch(title, requestedEp, expectedSeason)) return true;

    if (requestedEp === 1) {
        const epNum = extractEpisodeNumber(title, expectedSeason);
        if (epNum === null || epNum === 1) {
            return true;
        }
    }
    return false;
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
        let cleanQuery = sanitizeSearchQuery(extra.search);

        const [anilistMetas, sukebeiTorrents] = await Promise.all([
            searchAdultAnime(extra.search), 
            searchSukebeiForHentai(cleanQuery)
        ]);
        anilistMetas.sort((a, b) => {
            const dateA = a.released ? new Date(a.released).getTime() : Infinity;
            const dateB = b.released ? new Date(b.released).getTime() : Infinity;
            return dateA - dateB;
        });
        const finalMetas = anilistMetas.map(m => { m.type = "anime"; return m; });
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
                let sQuery = sanitizeSearchQuery(searchTitle);
                let torrents = await searchSukebeiForHentai(sQuery);
                
                if (torrents.length === 0) {
                    const words = sQuery.split(/\s+/);
                    if (words.length >= 3) {
                        torrents = await searchSukebeiForHentai(words.slice(0, 3).join(" "));
                    } else if (words.length === 2 && sQuery.length > 4) {
                        torrents = await searchSukebeiForHentai(sQuery);
                    }
                }

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
        const tbKeyToUse = userConfig.tbKey || INTERNAL_TB_KEY;
        if (!userConfig.rdKey && !tbKeyToUse) return { streams: [] };
        
        let searchTitle = "", requestedEp = 1, aniListIdForFallback = null;
        let expectedSeason = 1;
        let validSearchTitles = []; 
        const isMovie = type === "movie";
        
        const parts = id.split(":");

        if (id.startsWith("anilist:")) {
            let payload = parts[1];
            if (payload && payload.includes("-")) {
                let subParts = payload.split("-");
                aniListIdForFallback = subParts[0];
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                aniListIdForFallback = payload;
                requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
            }
            if (aniListIdForFallback) {
                const freshMeta = await getAnimeMeta(aniListIdForFallback);
                if (freshMeta) searchTitle = sanitizeSearchQuery(freshMeta.name);
            }
        } else if (id.startsWith("sukebei:")) {
            let payload = parts[1];
            if (payload && payload.includes("-")) {
                let subParts = payload.split("-");
                searchTitle = sanitizeSearchQuery(fromBase64Safe(subParts[0]));
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                searchTitle = sanitizeSearchQuery(fromBase64Safe(payload));
                requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
            }
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

        console.log(`\n[YOMI DEBUG] ===== NEUE SUCHE =====`);
        console.log(`[YOMI DEBUG] ID: ${id} | Episode: ${requestedEp}`);
        console.log(`[YOMI DEBUG] Initialer Such-Titel: "${searchTitle}"`);

        if (!searchTitle) {
            console.log(`[YOMI DEBUG] Abbruch: Kein Such-Titel gefunden.`);
            return { streams: [] };
        }
        validSearchTitles.push(searchTitle);

        const extractSeason = (t) => {
            const nthMatch = t.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/i);
            if (nthMatch) return parseInt(nthMatch[1], 10);
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            if (m) return parseInt(m[1], 10);
            if (/\b(?:second|ii)\b/i.test(t)) return 2;
            if (/\b(?:third|iii)\b/i.test(t)) return 3;
            if (/\b(?:fourth|iv)\b/i.test(t)) return 4;
            if (/\b(?:fifth|v)\b/i.test(t)) return 5;
            if (/\b(?:sixth|vi)\b/i.test(t)) return 6;
            return null;
        };

        if (!id.startsWith("tt")) {
            let detected = null;
            for (let s of validSearchTitles) {
                if (s) {
                    let d = extractSeason(s);
                    if (d && d > 1) { detected = d; break; }
                }
            }
            if (detected) expectedSeason = detected;
        }
        
        let torrents = await searchSukebeiForHentai(searchTitle);
        console.log(`[YOMI DEBUG] Sukebei Raw Results fuer Haupttitel: ${torrents.length}`);
        
        if (torrents.length < 15) {
            console.log("[YOMI DEBUG] Starte Universal Fallback Engine zur Erweiterung der Ergebnisse...");
            let fallbackMeta = aniListIdForFallback ? await getAnimeMeta(aniListIdForFallback) : null;
            if (fallbackMeta) {
                const fallbackTitles = new Set();
                
                // ===============
                // AOD AUTO-ALIASING INJECTION
                // Zieht alle verifizierten Tracker-Synonyme aus der JSON Map und injiziert sie direkt ins Fallback
                // ===============
                const aodAliases = aniListIdForFallback ? getAliasesByAniListId(aniListIdForFallback) : getAliasesByTitle(searchTitle);
                if (aodAliases && aodAliases.length > 0) {
                    console.log(`[YOMI DEBUG] ⚡ AOD-Datenbank Treffer! Injeziere ${aodAliases.length} offizielle Synonyme.`);
                    aodAliases.forEach(alias => {
                        if (alias.length > 4) fallbackTitles.add(alias);
                    });
                }

                if (fallbackMeta.altName && fallbackMeta.altName.length > 4) fallbackTitles.add(fallbackMeta.altName);
                if (fallbackMeta.synonyms) {
                    fallbackMeta.synonyms.forEach(syn => {
                        if (syn.length > 4) fallbackTitles.add(syn);
                    });
                }
                
                const primaryWords = searchTitle.split(/\s+/);
                const w2 = primaryWords.slice(0, 2).join(" ");
                const w3 = primaryWords.slice(0, 3).join(" ");
                const w4 = primaryWords.slice(0, 4).join(" ");
                
                if (primaryWords.length >= 2 && w2.length > 4) fallbackTitles.add(w2);
                if (primaryWords.length >= 3 && w3.length > 4) fallbackTitles.add(w3);
                if (primaryWords.length >= 4 && w4.length > 4) fallbackTitles.add(w4);
                
                // Limit auf 10 Fallbacks um gigantische Such-Queues zu verhindern
                const fallbackArr = Array.from(fallbackTitles).slice(0, 10);

                for (const altTitle of fallbackArr) {
                    if (!altTitle || validSearchTitles.includes(altTitle)) continue;
                    validSearchTitles.push(altTitle); 
                    
                    let d = extractSeason(altTitle);
                    if (d && d > 1 && expectedSeason === 1) expectedSeason = d;

                    const extraTorrents = await searchSukebeiForHentai(sanitizeSearchQuery(altTitle));
                    if (extraTorrents.length > 0) {
                        console.log(`[YOMI DEBUG] Zusaetzliche Treffer mit Fallback-Titel: "${altTitle}" -> ${extraTorrents.length} Torrents`);
                        torrents = torrents.concat(extraTorrents); 
                        if (torrents.length >= 15) {
                            console.log("[YOMI DEBUG] Ausreichend Torrents gefunden, beende Fallback-Suche.");
                            break;
                        }
                    }
                }
            }
        }

        const baseTitles = new Set();
        validSearchTitles.forEach(t => {
            const stripped = t.replace(/\b(?:\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)|Season\s*\d+|S\d+|Part\s*\d+|Cour\s*\d+|Episode\s*\d+|Ep\s*\d+)\b/ig, "")
                              .replace(/第\s*\d+\s*(?:季|期|기|話|话|集)/g, "")
                              .replace(/\s{2,}/g, " ").trim();
            if (stripped.length > 4) baseTitles.add(stripped);
        });
        const finalValidTitles = Array.from(baseTitles);

        console.log(`[YOMI DEBUG] Alle erlaubten Synonyme (inkl. Base-Titel):`, finalValidTitles);

        if (requestedEp === 1) {
            for (let t of validSearchTitles) {
                const epMatch = t.match(/(?:Episode|Ep\.|第)\s*(\d+)(?:\s*話)?/i);
                if (epMatch) {
                    const parsedOverride = parseInt(epMatch[1], 10);
                    if (parsedOverride > 1) {
                        console.log(`[YOMI DEBUG] ⚠️ OVA-Mapping erkannt! Ändere gesuchte Episode von 1 auf ${parsedOverride}`);
                        requestedEp = parsedOverride;
                        break;
                    }
                }
            }
        }

        let filterDropCount = 0;
        torrents = torrents.filter(t => {
            if (/\b(?:同人誌|同人CG集|Doujinshi|Manga|Artbook|Pictures|Images|CG集|Novel|Photobook|Cosplay)\b/i.test(t.title)) {
                filterDropCount++;
                return false;
            }

            const keep = verifyTitleMatch(t.title, finalValidTitles);
            if (!keep) { filterDropCount++; return false; }

            const bytes = parseSizeToBytes(t.size);
            const isBatch = isSeasonBatch(t.title, expectedSeason);
            
            if (!isMovie && !isBatch && bytes > 4.5 * 1024 * 1024 * 1024) {
                filterDropCount++;
                return false;
            }

            return true;
        });

        console.log(`[YOMI DEBUG] Titel-Filter hat ${filterDropCount} Torrents geloescht.`);
        console.log(`[YOMI DEBUG] Verbleibend nach Titel-Filter: ${torrents.length}`);

        if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

        const uniqueTorrents = new Map();
        torrents.forEach(t => uniqueTorrents.set(t.hash, t));
        torrents = Array.from(uniqueTorrents.values());

        const hashes = torrents.map(t => t.hash);
        
        console.log(`[YOMI DEBUG] Starte Debrid-Cache Prüfung für ${hashes.length} Hashes...`);
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            tbKeyToUse ? checkTorbox(hashes, tbKeyToUse).catch(() => ({})) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {}
        ]);
        console.log(`[YOMI DEBUG] Cache Prüfung abgeschlossen.`);

        const userLangs = Array.isArray(userConfig.language) ? userConfig.language : [userConfig.language || "ENG"];
        const streams = [];
        const flags = { "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" };

        let epDropCount = 0;

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const filesRD = rdC[hashLow]; const progRD = rdA[hashLow];
            const filesTB = tbC[hashLow]; const progTB = tbA[hashLow];
            const streamLang = extractLanguage(t.title, userLangs);
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            const seeders = parseInt(t.seeders, 10) || 0;
            
            const isBatch = isSeasonBatch(t.title, expectedSeason);
            const isEpMatch = yomiIsEpisodeMatch(t.title, requestedEp, expectedSeason);
            
            if (!isEpMatch) {
                epDropCount++;
                return; 
            }

            const batchStr = isBatch ? " | 📦 Batch" : "";

            if (userConfig.rdKey) {
                let matchedFile = filesRD ? selectBestVideoFile(filesRD, requestedEp, expectedSeason, isMovie) : null;
                const isStremThruCached = filesRD && filesRD.length > 0;
                const isDownloading = progRD !== undefined && progRD < 100;
                
                if (isStremThruCached && !matchedFile && !isMovie) {
                    epDropCount++;
                } else {
                    let streamStatus = "☁️ Download";
                    let uiName = `YOMI [☁️ RD]`;

                    if (isStremThruCached) {
                        uiName = `YOMI [⚡ RD+]`;
                        streamStatus = "⚡ Cached (StremThru)";
                    } else if (isDownloading) {
                        uiName = `YOMI [⏳ ${progRD}% RD]`;
                        streamStatus = `⏳ ${progRD}% Downloading`;
                    }
                    
                    const streamPayload = { 
                        name: `${uiName}\n🎥 ${res}`, 
                        description: `${flags[streamLang] || "🇬🇧"} | ${streamStatus}${batchStr}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${seeders} Seeds`, 
                        url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, 
                        behaviorHints: { bingeGroup: (isStremThruCached ? "rd_" : "dl_") + t.hash, notWebReady: !isStremThruCached }, 
                        _bytes: bytes, _lang: streamLang, _isCached: isStremThruCached, _res: res, _prog: progRD || 0, _seeders: seeders, _isBatch: isBatch 
                    };
                    
                    if (isStremThruCached && filesRD) {
                        const subFiles = filesRD.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                        if (subFiles.length > 0) {
                            streamPayload.subtitles = subFiles.map(sub => ({
                                id: String(sub.id),
                                url: `${BASE_URL}/sub/realdebrid/${userConfig.rdKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                                lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                            }));
                        }
                    }
                    streams.push(streamPayload);
                }
            }
            
            if (userConfig.tbKey) {
                let matchedFile = filesTB ? selectBestVideoFile(filesTB, requestedEp, expectedSeason, isMovie) : null;
                const isCached = filesTB && filesTB.length > 0;
                const isDownloading = progTB !== undefined && progTB < 100;
                
                if (isCached && !matchedFile && !isMovie) {
                } else {
                    let streamStatus = "☁️ Download";
                    let uiName = `YOMI [☁️ TB]`;

                    if (isCached) {
                        uiName = `YOMI [⚡ TB]`;
                        streamStatus = "⚡ Cached";
                    } else if (isDownloading) {
                        uiName = `YOMI [⏳ ${progTB}% TB]`;
                        streamStatus = `⏳ ${progTB}% Downloading`;
                    }

                    const streamPayload = { 
                        name: `${uiName}\n🎥 ${res}`, 
                        description: `${flags[streamLang] || "🇬🇧"} | ${streamStatus}${batchStr}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${seeders} Seeds`, 
                        url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, 
                        behaviorHints: { bingeGroup: (isCached ? "tb_" : "dl_") + t.hash, notWebReady: !isCached }, 
                        _bytes: bytes, streamLang, _isCached: isCached, _res: res, _prog: progTB || 0, _seeders: seeders, _isBatch: isBatch
                    };
                    
                    if (isCached && filesTB) {
                        const subFiles = filesTB.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                        if (subFiles.length > 0) {
                            streamPayload.subtitles = subFiles.map(sub => ({
                                id: String(sub.id),
                                url: `${BASE_URL}/sub/torbox/${userConfig.tbKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                                lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                            }));
                        }
                    }
                    streams.push(streamPayload);
                }
            }
        });

        console.log(`[YOMI DEBUG] Episoden-Filter hat ${epDropCount} nicht-passende Einträge gelöscht.`);
        console.log(`[YOMI DEBUG] Finale Streams an Stremio gesendet: ${streams.length}\n`);

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

            const aBatch = a._isBatch && (a._seeders > 0 || a._isCached) ? 1 : 0;
            const bBatch = b._isBatch && (b._seeders > 0 || b._isCached) ? 1 : 0;
            if (aBatch !== bBatch) return bBatch - aBatch;
            
            if (!a._isCached && !b._isCached) {
                if (b._seeders !== a._seeders) return b._seeders - a._seeders;
            }
            
            return b._bytes - a._bytes; 
        }), cacheMaxAge: 3600 };
    } catch (err) { 
        console.error(`[YOMI DEBUG] FATAL ERROR:`, err.message);
        return { streams: [] }; 
    }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
