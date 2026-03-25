/**
 * YOMI METADATA PROVIDER - ANILIST & MYANIMELIST (JIKAN)
 * * This module handles all metadata requests for the addon.
 * It features a robust caching system and automatic rate-limit handling 
 * to ensure high availability on limited hosting environments like Koyeb.
 */

const axios = require('axios');

const ANILIST_URL = 'https://graphql.anilist.co';

// ============================================================================
// CACHE & RATE LIMITING CONFIGURATION
// To avoid "429 Too Many Requests", we store results in a Map (RAM).
// This is essential because Stremio fires multiple requests during typing.
// ============================================================================
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // Cache duration: 6 hours
const MAX_CACHE_ENTRIES = 500;        // Keeps RAM usage low on Free Tier instances

/**
 * Utility: Pauses the execution for a given time.
 * Used for "Exponential Backoff" when APIs are overloaded.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * INTERNAL: Generic GraphQL Fetcher for AniList
 * Includes automatic Retries, Caching, and Error Handling.
 * * @param {string} query - The GraphQL query string.
 * @param {object} variables - Variables for the GraphQL query.
 * @param {number} retries - Number of attempts before giving up.
 */
async function _fetchAniList(query, variables, retries = 3) {
    // Check if result is already in RAM to save API credits
    const cacheKey = `anilist_${JSON.stringify(variables || {})}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
            
            // Validate response structure
            if (!response.data || !response.data.data || !response.data.data.Page) return [];
            
            // Map the raw API data to our internal Yomi Metadata Format
            const results = response.data.data.Page.media.map(anime => {
                const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                const base64Title = Buffer.from(cleanTitle).toString('base64url');
                
                return {
                    id: `anilist:${anime.id}:${base64Title}`, // Composite ID for easier parsing later
                    type: 'series', 
                    name: cleanTitle,
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "",
                    description: anime.description || "No description available.",
                    episodes: anime.episodes || 1
                };
            });

            // Store in Cache and prevent memory leaks by limiting size
            apiCache.set(cacheKey, { timestamp: Date.now(), data: results });
            if (apiCache.size > MAX_CACHE_ENTRIES) apiCache.clear();

            return results;

        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[AniList] Fetch Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            // If we hit a Rate Limit (429), wait longer before retrying
            if (attempt < retries - 1) {
                const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
                await sleep(waitTime);
            }
        }
    }
    return []; // Return empty array if all retries failed
}

/**
 * Searches for Adult (NSFW) Anime on AniList.
 * @param {string} query - The search term (e.g., "Mama x Holic").
 */
async function searchAdultAnime(query) {
    if (!query || query.length < 3) return [];
    
    const graphqlQuery = `
        query ($search: String) { 
            Page(page: 1, perPage: 50) { 
                media(search: $search, type: ANIME, isAdult: true) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

/**
 * Fetches the currently trending NSFW Anime for the main catalog.
 */
async function getTrendingAdultAnime() {
    const graphqlQuery = `
        query { 
            Page(page: 1, perPage: 30) { 
                media(type: ANIME, isAdult: true, sort: TRENDING_DESC) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { type: "trending" });
}

/**
 * Fetches the highest-rated NSFW Anime for the main catalog.
 */
async function getTopAdultAnime() {
    const graphqlQuery = `
        query { 
            Page(page: 1, perPage: 30) { 
                media(type: ANIME, isAdult: true, sort: SCORE_DESC) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { type: "top" });
}

/**
 * Fetches detailed metadata for a specific AniList ID.
 * This is used when a user clicks on an Anime to see its info page.
 */
async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = `anilist_meta_${anilistId}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    const graphqlQuery = `
        query ($id: Int) { 
            Media(id: $id, type: ANIME) { 
                id 
                title { romaji english } 
                coverImage { extraLarge } 
                bannerImage 
                description 
                format 
                episodes 
            } 
        }`;
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.post(ANILIST_URL, { query: graphqlQuery, variables: { id: parseInt(anilistId) } }, { timeout: 6000 });
            const anime = response.data?.data?.Media;
            if (!anime) return null;

            const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
            const base64Title = Buffer.from(cleanTitle).toString('base64url');

            const result = {
                id: `anilist:${anime.id}:${base64Title}`,
                type: 'series',
                name: cleanTitle,
                poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                background: anime.bannerImage || "",
                description: anime.description || "No description available.",
                episodes: anime.episodes || 1
            };

            apiCache.set(cacheKey, { timestamp: Date.now(), data: result });
            if (apiCache.size > MAX_CACHE_ENTRIES) apiCache.clear();

            return result;

        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[AniList] Meta Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            if (attempt < retries - 1) {
                const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
                await sleep(waitTime);
            }
        }
    }
    return null;
}

/**
 * FALLBACK: MYANIMELIST (JIKAN API)
 * Used when AniList doesn't know a specific title found on Sukebei.
 * Note: Jikan has a strict limit of 3 requests per second.
 * * @param {string} cleanedTitle - The sanitized title to search for.
 */
async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = `jikan_${cleanedTitle}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // sfw=false explicitly allows 18+ results in the MAL database
            const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanedTitle)}&sfw=false&limit=1`;
            const response = await axios.get(url, { timeout: 4000 });
            const data = response.data?.data;
            
            if (data && data.length > 0) {
                const anime = data[0];
                const result = {
                    poster: anime.images?.jpg?.large_image_url || null,
                    background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                    description: anime.synopsis || "Description provided by MyAnimeList.",
                    episodes: anime.episodes || null
                };

                apiCache.set(cacheKey, { timestamp: Date.now(), data: result });
                if (apiCache.size > MAX_CACHE_ENTRIES) apiCache.clear();

                return result;
            }
            return null; // Nothing relevant found
        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[Jikan MAL] Fallback Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            if (attempt < retries - 1) {
                // Jikan is very sensitive. We wait longer (3s+) on 429 errors.
                const waitTime = (status === 429) ? 3000 * (attempt + 1) : 1000;
                await sleep(waitTime);
            }
        }
    }
    return null;
}

module.exports = { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getJikanMeta };
