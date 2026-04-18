//===============
// YOMI DUAL-SCRAPER ENGINE (SUKEBEI + ANIDEX)
// Optimiert fuer maximale Ausbeute bei NSFW-Anime.
// Nutzt paralleles Asynchron-Fetching und Hash-Deduplizierung.
//===============

const axios = require("axios");

const MIRRORS = [
    "https://sukebei.nyaa.si",
    "https://sukebei.nyaa.iss.one",
    "https://sukebei.nyaa.land",
    "https://sukebei.nyaa.tracker.wf"
];

let currentMirrorIndex = 0;
function getNextMirror() {
    currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
    return MIRRORS[currentMirrorIndex];
}

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

// Die mathematische Queue-Logik gegen Rate-Limits
let lastRequestTime = 0;
const DELAY_MS = 1200; 

async function fetchWithQueue(url) {
    const now = Date.now();
    const timeToWait = Math.max(0, lastRequestTime + DELAY_MS - now);
    lastRequestTime = now + timeToWait + 100; 
    
    if (timeToWait > 0) {
        await new Promise(res => setTimeout(res, timeToWait));
    }
    
    return axios.get(url, {
        timeout: 10000,
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml, */*"
        }
    });
}

function cleanTorrentTitle(title) {
    let clean = title;
    clean = clean.replace(/\[.*?\]/g, "");
    clean = clean.replace(/\(.*?\)/g, "");
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, "");
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, "");
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, "");
    clean = clean.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
    return clean || title; 
}

//===============
// ROBUSTER RSS XML PARSER
// Funktioniert nahtlos fuer Sukebei und AniDex RSS-Feeds
//===============
function parseRSS(xml, sourceName) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];

        let title = "";
        const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        if (titleMatch) title = titleMatch[1].trim();

        let hash = "";
        const hashMatch = itemXml.match(/(?:infoHash>|urn:btih:)([a-fA-F0-9]{40})/i);
        if (hashMatch) hash = hashMatch[1].toLowerCase();

        let size = "0 B";
        const sizeMatchNyaa = itemXml.match(/<(?:nyaa:size|size)>([\s\S]*?)<\/(?:nyaa:size|size)>/);
        const sizeMatchTor = itemXml.match(/<torrent:contentLength>(\d+)<\/torrent:contentLength>/);

        if (sizeMatchNyaa) {
            size = sizeMatchNyaa[1];
        } else if (sizeMatchTor) {
            const bytes = parseInt(sizeMatchTor[1], 10);
            if (bytes >= 1073741824) size = (bytes / 1073741824).toFixed(2) + " GiB";
            else if (bytes >= 1048576) size = (bytes / 1048576).toFixed(2) + " MiB";
            else size = (bytes / 1024).toFixed(2) + " KiB";
        }

        let seeders = 0;
        const seedMatchNyaa = itemXml.match(/<(?:nyaa:seeders|seeders)>(\d+)<\/(?:nyaa:seeders|seeders)>/);
        const seedMatchTor = itemXml.match(/<torrent:seeds>(\d+)<\/torrent:seeds>/);

        if (seedMatchNyaa) seeders = parseInt(seedMatchNyaa[1], 10);
        else if (seedMatchTor) seeders = parseInt(seedMatchTor[1], 10);

        if (title && hash) {
            items.push({
                title: title, 
                hash: hash,
                size: size,
                seeders: seeders,
                source: sourceName
            });
        }
    }
    return items;
}

//===============
// MAIN EXPORT: DUAL AGGREGATOR
//===============
async function searchSukebeiForHentai(queryOriginal) {
    if (!queryOriginal || queryOriginal.trim().length < 3) return [];

    const queryKey = queryOriginal.trim().toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
        searchCache.delete(queryKey);
    }

    console.log(`\n[DUAL-SCRAPER] 🔍 Bereite Suche vor für: "${queryOriginal.trim()}"`);

    const queries = [queryOriginal.trim()];
    const delimiters = /[:!\-~]/;
    if (delimiters.test(queryOriginal)) {
        const shortTitle = queryOriginal.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) queries.push(shortTitle);
    }

    const uniqueResults = new Map();

    for (const query of queries) {
        console.log(`[DUAL-SCRAPER] 🚀 Starte Sub-Query: "${query}"`);
        const safeQuery = encodeURIComponent(query);
        
        // 1. Sukebei Suche
        const fetchSukebei = async () => {
            let attempts = 0;
            let success = false;
            let results = [];
            while (attempts < MIRRORS.length && !success) {
                const domain = MIRRORS[currentMirrorIndex];
                const rssUrl = `${domain}/?page=rss&c=0_0&f=0&q=${safeQuery}`;
                try {
                    const response = await fetchWithQueue(rssUrl);
                    if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) throw new Error("Cloudflare Block");
                    results = parseRSS(response.data, "Sukebei");
                    console.log(`[SCRAPER] ✅ Sukebei (${domain}) lieferte ${results.length} Roh-Ergebnisse.`);
                    success = true;
                } catch (error) {
                    getNextMirror();
                    attempts++;
                }
            }
            if (!success) console.log(`[SCRAPER] ❌ Sukebei fehlgeschlagen.`);
            return results;
        };

        // 2. AniDex Suche (Die einzige viable NSFW Alternative)
        const fetchAniDex = async () => {
            try {
                // AniDex liefert Anime, Manga und Hentai über die globale Suche
                const anidexUrl = `https://anidex.info/rss/?q=${safeQuery}`;
                const response = await fetchWithQueue(anidexUrl);
                if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) throw new Error("HTML Block");
                const results = parseRSS(response.data, "AniDex");
                console.log(`[SCRAPER] ✅ AniDex lieferte ${results.length} Roh-Ergebnisse.`);
                return results;
            } catch (error) {
                console.log(`[SCRAPER] ❌ AniDex fehlgeschlagen.`);
                return [];
            }
        };

        const [sukebeiRes, anidexRes] = await Promise.all([
            fetchSukebei(),
            fetchAniDex()
        ]);

        const allResults = [...sukebeiRes, ...anidexRes];

        // Deduplizierung über Hash (Behält die Quelle mit mehr Seedern)
        allResults.forEach(t => {
            if (!uniqueResults.has(t.hash) || t.seeders > uniqueResults.get(t.hash).seeders) {
                uniqueResults.set(t.hash, t);
            }
        });
    }

    const finalArr = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[SCRAPER] 🏆 Gesamt nach Deduplizierung: ${finalArr.length} Torrents für den Parser bereit.`);
    
    searchCache.set(queryKey, { data: finalArr, expiresAt: Date.now() + CACHE_TTL_MS });
    return finalArr;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
