/**
 * YOMI TORRENT PROVIDER - SUKEBEI (NYAA)
 * * This module is responsible for crawling the Sukebei tracker.
 * It uses an advanced In-Memory Cache and "Promise Deduping" to ensure
 * high performance and prevent unnecessary network overhead.
 */

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// ============================================================================
// STATELESS RAM CACHING & DEDUPING
// Stremio often fires identical requests in rapid succession.
// To handle this, we store the actual "Promise" in the Map while it's fetching.
// This ensures that multiple identical queries only trigger ONE network request.
// ============================================================================
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache duration

/**
 * Normalizes messy torrent titles for better grouping in Stremio.
 * Removes common "noise" like brackets, resolutions, and file extensions.
 * * @param {string} title - The raw torrent title from the tracker.
 * @returns {string} - The cleaned title used for metadata matching.
 */
function cleanTorrentTitle(title) {
    let clean = title;
    
    // Remove content inside brackets and parentheses [Hentai-Group] (1280x720)
    clean = clean.replace(/\[.*?\]/g, '');
    clean = clean.replace(/\(.*?\)/g, '');
    
    // Strip common video extensions
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, '');
    
    // Remove isolated episode indicators like " - 01" or "Episode 5"
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, '');
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, '');
    
    // Clean out technical tags and resolution markers
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, '');
    
    // Replace underscores with spaces and collapse multiple spaces
    clean = clean.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
    
    return clean || title; 
}

/**
 * Searches the Sukebei RSS feed for a specific title.
 * Implements deduplication: if the search is already running, it returns the existing promise.
 * * @param {string} romajiTitle - The title to search for.
 * @returns {Promise<Array>} - A sorted array of torrent objects.
 */
async function searchSukebeiForHentai(romajiTitle) {
    // GUARD: Ignore very short queries to prevent tracker spam
    if (!romajiTitle || romajiTitle.trim().length < 4) {
        return [];
    }

    const queryKey = romajiTitle.trim().toLowerCase();

    // 1. CACHE & DEDUPING CHECK
    if (searchCache.has(queryKey)) {
        const cachedItem = searchCache.get(queryKey);
        
        // If it's a finished result and hasn't expired yet, return it
        if (cachedItem.expiresAt > Date.now()) {
            // Note: If 'data' is a Promise (request currently running), we return that Promise!
            if (cachedItem.data instanceof Promise) {
                return cachedItem.data;
            }
            console.log(`[SUKEBEI CACHE HIT] Loading from RAM: "${queryKey}"`);
            return cachedItem.data;
        } else {
            searchCache.delete(queryKey); // Cache expired
        }
    }

    // 2. CONSTRUCT THE SEARCH PROMISE
    const fetchPromise = (async () => {
        const encodedQuery = encodeURIComponent(romajiTitle);
        // RSS Category 1_1 (Anime - English-translated) or adjust as needed
        const rssUrl = `https://sukebei.nyaa.si/?page=rss&c=1_1&f=0&q=${encodedQuery}`;

        try {
            console.log(`[SUKEBEI NETWORK] Starting fresh query for: "${queryKey}"`);
            
            // TIMEOUT: Stremio cancels internally after ~15s. We use 12s as a safe limit.
            const response = await axios.get(rssUrl, {
                timeout: 12000,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" }
            });

            // Detect Cloudflare "Just a moment" or rate-limit pages
            if (typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE html>')) {
                throw new Error("Cloudflare block or HTML received instead of RSS XML.");
            }

            // Parse the XML response
            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

            // 3. DATA NORMALIZATION
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
            })
            .filter(t => t.hash !== null) // Ensure we only have valid torrents
            .sort((a, b) => b.seeders - a.seeders); // Sort by popularity (seeders)

            // 4. PERSIST FINAL DATA IN CACHE
            searchCache.set(queryKey, {
                data: results,
                expiresAt: Date.now() + CACHE_TTL_MS
            });

            return results;

        } catch (error) {
            console.error(`[SUKEBEI ERROR] Aborted for "${romajiTitle}":`, error.message);
            searchCache.delete(queryKey); // Clear from cache so we can retry later
            return [];
        }
    })();

    // 5. ATTACH THE RUNNING PROMISE TO THE CACHE (DEDUPING)
    // Identical requests arriving while this is running will wait for 'fetchPromise'.
    searchCache.set(queryKey, {
        data: fetchPromise,
        expiresAt: Date.now() + CACHE_TTL_MS
    });

    return fetchPromise;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
