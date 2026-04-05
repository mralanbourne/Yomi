//===============
// YOMI SUKEBEI SCRAPER
// Accesses the Sukebei RSS feed directly and processes the torrents.
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

//===============
// IN-MEMORY CACHE & PROMISE DEDUPING
// high-performance LRU cache to prevent memory leaks and handle concurrent requests from Stremio.
//===============
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
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
// Generates fallback queries for strict trackers
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
// Cleans up messy torrent names to group them neatly in the catalog.
// Removes unwanted tags, resolutions, and file extensions.
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
// Searches Sukebei for matching torrents using in-memory caching
// and request deduplication.
//===============
async function searchSukebeiForHentai(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 4) {
        return [];
    }

    const queryKey = romajiTitle.trim().toLowerCase();
    const cachedItem = getSukebeiCache(queryKey);

    if (cachedItem) {
        console.log("[SUKEBEI CACHE HIT] Loading from RAM: " + queryKey);
        return cachedItem.data;
    }

    const fetchPromise = (async () => {
        const queries = generateSearchQueries(romajiTitle);
        const allItems = [];

        const fetchTasks = queries.map(async (query) => {
            const encodedQuery = encodeURIComponent(query);
            const rssUrl = "https://sukebei.nyaa.si/?page=rss&c=1_1&f=0&q=" + encodedQuery;

            try {
                console.log("[SUKEBEI NETWORK] Executing query: " + query);
                
                const response = await axios.get(rssUrl, {
                    timeout: 12000,
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" }
                });

                if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                    throw new Error("Cloudflare Rate-Limit HTML block received.");
                }

                const parser = new XMLParser({ ignoreAttributes: true });
                const jsonObj = parser.parse(response.data);
                const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
                return items;

            } catch (error) {
                console.error("[SUKEBEI ERROR] Query failed for '" + query + "': " + error.message);
                return [];
            }
        });

        const resultsArrays = await Promise.all(fetchTasks);
        resultsArrays.forEach(items => {
            if (Array.isArray(items)) {
                allItems.push(...items);
            }
        });

        if (allItems.length === 0) {
            searchCache.delete(queryKey);
            return [];
        }

        const uniqueResults = new Map();
        
        allItems.forEach(item => {
            const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
            if (!hash || uniqueResults.has(hash)) return;

            let rawSize = item["nyaa:size"] || "Unknown";
            if (typeof rawSize === "string" && (rawSize.includes("NOT_INDEX") || rawSize === "Unknown")) {
                rawSize = "? GB"; 
            }

            let seeders = parseInt(item["nyaa:seeders"], 10);
            if (isNaN(seeders)) {
                seeders = 0; 
            }

            uniqueResults.set(hash, {
                title: item.title || "Unknown Release",
                hash: hash,
                seeders: seeders,
                size: rawSize
            });
        });

        const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);

        setSukebeiCache(queryKey, results);
        return results;

    })();

    setSukebeiCache(queryKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
