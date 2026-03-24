const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// IN-MEMORY CACHE & PROMISE DEDUPING (STATELESS CACHING)
// Since we are operating without a database, we use the RAM of the Node instance.
// searchCache stores either the final result OR the currently running request.
// This prevents Stremio from bombarding Sukebei with parallel, identical queries.
// If the server restarts or enters sleep mode, this cache will be cleared.
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // Results remain in RAM for 30 minutes

// Cleans dirty torrent titles to group them correctly in the catalog.
// Removes unwanted tags, resolutions, and file extensions.
function cleanTorrentTitle(title) {
    let clean = title;
    clean = clean.replace(/\[.*?\]/g, '');
    clean = clean.replace(/\(.*?\)/g, '');
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, '');
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, '');
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, '');
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, '');
    clean = clean.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
    
    return clean || title; 
}

// Searches Sukebei for matching torrents utilizing in-memory caching and request deduplication.
async function searchSukebeiForHentai(romajiTitle) {
    // GUARD CLAUSE: Stremio triggers a search on every keystroke. 
    // We rigorously ignore anything under 4 characters to avoid blocking Sukebei with useless tarpit queries.
    if (!romajiTitle || romajiTitle.trim().length < 4) {
        return [];
    }

    // Normalize the search term for the cache key (lowercase, trimmed)
    const queryKey = romajiTitle.trim().toLowerCase();

    // CACHE HIT CHECK: Have we already searched for this or is it currently running?
    if (searchCache.has(queryKey)) {
        const cachedItem = searchCache.get(queryKey);
        
        // Check if the cache entry is still valid
        if (cachedItem.expiresAt > Date.now()) {
            console.log(`[SUKEBEI CACHE HIT] Loading from RAM: "${queryKey}"`);
            
            // If data is a Promise (request still running), we await it.
            // If it is an array (request finished), it returns immediately.
            return cachedItem.data;
        } else {
            // Cache expired, remove it and proceed.
            searchCache.delete(queryKey);
        }
    }

    // NEW REQUEST (CREATE PROMISE)
    // We wrap the Axios logic in an async function, execute it, but DO NOT await it 
    // immediately (we store the running Promise in the cache).
    const fetchPromise = (async () => {
        const encodedQuery = encodeURIComponent(romajiTitle);
        const rssUrl = `https://sukebei.nyaa.si/?page=rss&c=1_1&f=0&q=${encodedQuery}`;

        try {
            console.log(`[SUKEBEI NETWORK] Starting fresh query for: "${queryKey}"`);
            
            // TIMEOUT STRATEGY: Stremio cancels internally after ~15 seconds. 
            // There is no point waiting 30 seconds for Sukebei. 12 seconds is the sweet spot.
            const response = await axios.get(rssUrl, {
                timeout: 12000,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" }
            });

            // Cloudflare-Protection-Check (Sukebei often returns a HTML captcha page instead of XML)
            if (typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE html>')) {
                throw new Error("Cloudflare Rate-Limit HTML block received.");
            }

            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

            // Map and normalize results
            const results = items.map(item => {
                let rawSize = item["nyaa:size"] || "Unknown";
                if (rawSize.includes("NOT_INDEX") || rawSize === "Unknown") {
                    rawSize = "? GB"; 
                }

                let seeders = parseInt(item["nyaa:seeders"], 10);
                if (isNaN(seeders)) {
                    seeders = 0; 
                }

                return {
                    title: item.title || "Unknown Release",
                    hash: item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null,
                    seeders: seeders,
                    size: rawSize
                };
            }).filter(t => t.hash !== null).sort((a, b) => b.seeders - a.seeders);

            // UPDATE CACHE (Replace Promise with final data)
            // If the request was successful, we overwrite the running Promise in RAM with the actual array.
            searchCache.set(queryKey, {
                data: results,
                expiresAt: Date.now() + CACHE_TTL_MS
            });

            return results;

        } catch (error) {
            console.error(`[SUKEBEI ERROR] Aborted for "${romajiTitle}":`, error.message);
            
            // IMPORTANT: If the request fails (e.g. timeout), we delete the broken Promise 
            // from the cache so the next attempt starts fresh instead of inheriting the error.
            searchCache.delete(queryKey);
            return [];
        }
    })();

    // CACHE RUNNING PROMISE
    // We store the Promise in RAM BEFORE awaiting it. 
    // If a second query for the same term arrives 100ms later, it receives this Promise 
    // and waits alongside the first query for the same network response.
    searchCache.set(queryKey, {
        data: fetchPromise,
        expiresAt: Date.now() + CACHE_TTL_MS
    });

    // AWAIT RESULT AND RETURN
    return fetchPromise;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
