//===============
// YOMI MULTI-SCRAPER ENGINE (SUKEBEI + TOKYOTOSHO + ANIMETOSHO)
// Implementiert asynchrones Fetching, Queue-Rate-Limiting, Delimiter-Splitting und Hash-Deduplizierung.
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

// Die mathematische Queue-Logik gegen Cloudflare-Bans
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
// Umgeht Parsing-Probleme mit unterschiedlichen RSS-Strukturen der drei Tracker
//===============
function parseRSS(xml, sourceName) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];

        // Titel extrahieren
        let title = "";
        const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        if (titleMatch) title = titleMatch[1].trim();

        // Hash extrahieren (Unterstützt Nyaa, AnimeTosho und generische Magnet-Links)
        let hash = "";
        const hashMatch = itemXml.match(/(?:infoHash>|urn:btih:)([a-fA-F0-9]{40})/i);
        if (hashMatch) hash = hashMatch[1].toLowerCase();

        // Größe extrahieren
        let size = "0 B";
        const sizeMatchNyaa = itemXml.match(/<(?:nyaa:size|size)>([\s\S]*?)<\/(?:nyaa:size|size)>/);
        const sizeMatchTor = itemXml.match(/<torrent:contentLength>(\d+)<\/torrent:contentLength>/);
        const sizeMatchDesc = itemXml.match(/Size:\s*([\d.]+\s*[KMG]?i?B)/i);

        if (sizeMatchNyaa) {
            size = sizeMatchNyaa[1];
        } else if (sizeMatchTor) {
            const bytes = parseInt(sizeMatchTor[1], 10);
            if (bytes >= 1073741824) size = (bytes / 1073741824).toFixed(2) + " GiB";
            else if (bytes >= 1048576) size = (bytes / 1048576).toFixed(2) + " MiB";
            else size = (bytes / 1024).toFixed(2) + " KiB";
        } else if (sizeMatchDesc) {
            size = sizeMatchDesc[1];
        }

        // Seeder extrahieren
        let seeders = 0;
        const seedMatchNyaa = itemXml.match(/<(?:nyaa:seeders|seeders)>(\d+)<\/(?:nyaa:seeders|seeders)>/);
        const seedMatchTor = itemXml.match(/<torrent:seeds>(\d+)<\/torrent:seeds>/);
        const seedMatchDesc = itemXml.match(/Seeders:\s*(\d+)/i);
        const seedMatchStats = itemXml.match(/S:\s*(\d+)/i); 

        if (seedMatchNyaa) seeders = parseInt(seedMatchNyaa[1], 10);
        else if (seedMatchTor) seeders = parseInt(seedMatchTor[1], 10);
        else if (seedMatchDesc) seeders = parseInt(seedMatchDesc[1], 10);
        else if (seedMatchStats) seeders = parseInt(seedMatchStats[1], 10);

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
// MAIN EXPORT: PARALLEL AGGREGATOR MIT DELIMITER FALLBACK
//===============
async function searchSukebeiForHentai(queryOriginal) {
    if (!queryOriginal || queryOriginal.trim().length < 3) return [];

    const queryKey = queryOriginal.trim().toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
        searchCache.delete(queryKey);
    }

    console.log(`\n[MULTI-SCRAPER] 🔍 Bereite Suche vor für: "${queryOriginal.trim()}"`);

    //===============
    // DELIMITER SPLIT LOGIK WIEDERHERGESTELLT
    //===============
    const queries = [queryOriginal.trim()];
    const delimiters = /[:!\-~]/;
    if (delimiters.test(queryOriginal)) {
        const shortTitle = queryOriginal.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) queries.push(shortTitle);
    }

    let allResults = [];

    for (const query of queries) {
        console.log(`[MULTI-SCRAPER] 🚀 Starte Sub-Query: "${query}"`);
        const safeQuery = encodeURIComponent(query);

        // 1. Sukebei-Suche (Mit Mirror-Fallback und Kategorie 0_0)
        const fetchSukebei = async () => {
            let attempts = 0;
            let success = false;
            let results = [];
            
            while (attempts < MIRRORS.length && !success) {
                const domain = MIRRORS[currentMirrorIndex];
                // WIEDERHERGESTELLT: Kategorie 0_0 um keine RAWs / falsch kategorisierte Torrents zu verpassen
                const rssUrl = `${domain}/?page=rss&c=0_0&f=0&q=${safeQuery}`;
                
                try {
                    const response = await fetchWithQueue(rssUrl);
                    if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                        throw new Error("Cloudflare Block");
                    }
                    results = parseRSS(response.data, "Sukebei");
                    console.log(`[SCRAPER] ✅ Sukebei (${domain}) lieferte ${results.length} Roh-Ergebnisse.`);
                    success = true;
                } catch (error) {
                    getNextMirror();
                    attempts++;
                }
            }
            if (!success) console.log(`[SCRAPER] ❌ Sukebei lieferte 0 Ergebnisse oder schlug fehl.`);
            return results;
        };

        // 2. TokyoTosho-Suche
        const fetchTokyoTosho = async () => {
            try {
                const tokyoUrl = `https://www.tokyotosho.info/rss.php?terms=${safeQuery}&type=9`;
                const response = await fetchWithQueue(tokyoUrl);
                const results = parseRSS(response.data, "TokyoTosho");
                console.log(`[SCRAPER] ✅ TokyoTosho lieferte ${results.length} Roh-Ergebnisse.`);
                return results;
            } catch (error) {
                console.log(`[SCRAPER] ❌ TokyoTosho lieferte 0 Ergebnisse oder schlug fehl.`);
                return [];
            }
        };

        // 3. AnimeTosho-Suche
        const fetchAnimeTosho = async () => {
            try {
                const toshoUrl = `https://feed.animetosho.org/rss2?q=${safeQuery}`;
                const response = await fetchWithQueue(toshoUrl);
                const results = parseRSS(response.data, "AnimeTosho");
                console.log(`[SCRAPER] ✅ AnimeTosho lieferte ${results.length} Roh-Ergebnisse.`);
                return results;
            } catch (error) {
                console.log(`[SCRAPER] ❌ AnimeTosho lieferte 0 Ergebnisse oder schlug fehl.`);
                return [];
            }
        };

        const [sukebeiRes, tokyoRes, toshoRes] = await Promise.all([
            fetchSukebei(),
            fetchTokyoTosho(),
            fetchAnimeTosho()
        ]);

        allResults.push(...sukebeiRes, ...tokyoRes, ...toshoRes);
    }

    //===============
    // DEDUPLIZIERUNG
    //===============
    const uniqueResults = new Map();
    allResults.forEach(t => {
        if (!uniqueResults.has(t.hash)) {
            uniqueResults.set(t.hash, t);
        } else {
            if (t.seeders > uniqueResults.get(t.hash).seeders) {
                uniqueResults.set(t.hash, t);
            }
        }
    });

    const finalArr = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[SCRAPER] 🏆 Gesamt nach Deduplizierung: ${finalArr.length} Torrents für den Parser bereit.`);
    
    searchCache.set(queryKey, { data: finalArr, expiresAt: Date.now() + CACHE_TTL_MS });
    return finalArr;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
