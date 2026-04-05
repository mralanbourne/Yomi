//===============
// YOMI SUKEBEI SCRAPER LIBRARY
// Optimized with Mirror-Rotation, RSS-Fallback, and Proxy-Support
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const MIRRORS = [
    (process.env.SUKEBEI_DOMAIN || "https://sukebei.nyaa.si").replace(/\/+$/, ""),
    "https://sukebei.nyaa.iss.one",
    "https://sukebei.si",
    "https://sukebei.land"
];

let currentMirrorIndex = 0;

function getNextMirror() {
    currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
    return MIRRORS[currentMirrorIndex];
}

//===============
// IN-MEMORY CACHE & PROMISE DEDUPING
//===============
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 Minuten
const MAX_CACHE_ENTRIES = 2000;

function setSukebeiCache(key, dataOrPromise) {
    if (searchCache.has(key)) {
        searchCache.delete(key);
    } else if (searchCache.size >= MAX_CACHE_ENTRIES) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(key, {
        data: dataOrPromise,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

function getSukebeiCache(key) {
    if (searchCache.has(key)) {
        const item = searchCache.get(key);
        if (item.expiresAt > Date.now()) {
            searchCache.delete(key);
            searchCache.set(key, item);
            return item;
        } else {
            searchCache.delete(key);
        }
    }
    return null;
}

//===============
// SEARCH QUERY OPTIMIZER
//===============
function generateSearchQueries(title) {
    const queries = new Set();
    if (!title) return [];
    queries.add(title.trim());
    
    const delimiters = /[:!\-~]/;
    if (delimiters.test(title)) {
        const shortTitle = title.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) {
            queries.add(shortTitle);
        }
    }
    return Array.from(queries);
}

//===============
// Cleans up messy torrent names
//===============
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
// SEARCH ENGINE WITH PROXY & MIRROR FALLBACK
//===============
async function searchSukebeiForHentai(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 3) return [];

    const queryKey = romajiTitle.trim().toLowerCase();
    const cachedItem = getSukebeiCache(queryKey);

    if (cachedItem) {
        console.log("[SUKEBEI CACHE HIT] Loading from RAM: " + queryKey);
        return cachedItem.data;
    }

    const fetchPromise = (async () => {
        const queries = generateSearchQueries(romajiTitle);
        const PROXY_URL = process.env.PROXY_URL;
        const uniqueResults = new Map();

        for (const query of queries) {
            let attempts = 0;
            let success = false;

            while (attempts < MIRRORS.length && !success) {
                const domain = MIRRORS[currentMirrorIndex];
                const rssUrl = `${domain}/?page=rss&c=1_1&f=0&q=${encodeURIComponent(query)}`;

                try {
                    const config = {
                        timeout: 12000,
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36"
                        }
                    };

                    // Proxy-Integration
                    if (PROXY_URL) {
                        const { HttpsProxyAgent } = require("https-proxy-agent");
                        config.httpsAgent = new HttpsProxyAgent(PROXY_URL);
                    }

                    console.log(`[SUKEBEI NETWORK] Trying ${domain} for query: ${query}`);
                    const response = await axios.get(rssUrl, config);

                    if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                        throw new Error("Cloudflare/HTML-Block received instead of RSS.");
                    }

                    const parser = new XMLParser({ ignoreAttributes: true });
                    const jsonObj = parser.parse(response.data);
                    const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

                    items.forEach(item => {
                        const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
                        if (!hash || uniqueResults.has(hash)) return;

                        let rawSize = item["nyaa:size"] || "Unknown";
                        let seeders = parseInt(item["nyaa:seeders"], 10) || 0;

                        uniqueResults.set(hash, {
                            title: item.title || "Unknown Release",
                            hash: hash,
                            seeders: seeders,
                            size: rawSize
                        });
                    });

                    success = true;
                } catch (error) {
                    console.warn(`[Sukebei] Mirror ${domain} failed: ${error.message}. Rotating...`);
                    getNextMirror();
                    attempts++;
                }
            }
        }

        const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
        
        if (results.length === 0) {
            searchCache.delete(queryKey);
        } else {
            setSukebeiCache(queryKey, results);
        }
        
        return results;
    })();

    setSukebeiCache(queryKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
