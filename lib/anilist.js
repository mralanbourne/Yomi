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
 * Pauses the execution for a given time.
 * Used for "Exponential Backoff" when APIs are overloaded.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sanitizes descriptions by removing HTML tags, formatting line breaks, and filtering spoilers.
 * It also injects a clean metadata header to improve the Stremio UI.
 * Works universally for both AniList AND MyAnimeList (Jikan) data.
 */
function formatDescription(anime) {
    let text = anime.description || anime.synopsis || "No description available.";

    // 1. Remove AniList spoiler tags (~! ... !~)
    text = text.replace(/~![\s\S]*?!~/g, '[Spoiler removed]');
    
    // 2. Convert linebreaks (<br> or <br />) into actual \n
    text = text.replace(/<br\s*\/?>/gi, '\n');
    
    // 3. Completely remove all remaining HTML tags (<i>, <b>, <span>, <em> etc.)
    text = text.replace(/<[^>]*>?/gm, '');
    
    // 4. Decode HTML entities (e.g., &quot; to ")
    text = text.replace(/&quot;/g, '"')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&#039;/g, "'")
               .replace(/&mdash;/g, '—');
               
    // 5. Remove MAL-specific artifacts
    text = text.replace(/\[Written by MAL Rewrite\]/gi, '').trim();

    // 6. Clean up multiple empty lines and hidden Windows linebreaks (\r)
    text = text.replace(/\r/g, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // 7. Build the metadata header
    let header = [];
    if (anime.format) header.push(`📺 Format: ${anime.format}`);
    if (anime.status) header.push(`📌 Status: ${anime.status.replace(/_/g, ' ')}`);
    if (anime.seasonYear) header.push(`📅 Year: ${anime.seasonYear}`);
    if (anime.averageScore) header.push(`⭐️ Score: ${anime.averageScore}%`);
    
    if (header.length > 0) {
        return `${header.join(' | ')}\n\n${text}`;
    }

    return text;
}

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
                    description: formatDescription(anime),
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
                    averageScore
                    status
                    seasonYear
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
                    averageScore
                    status
                    seasonYear
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
                    averageScore
                    status
                    seasonYear
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
                averageScore
                status
                seasonYear
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
                description: formatDescription(anime),
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
                
                // Map MAL data so formatDescription can use it for the info header
                const formattedDesc = formatDescription({ 
                    synopsis: anime.synopsis,
                    format: anime.type,
                    status: anime.status,
                    seasonYear: anime.year,
                    averageScore: anime.score ? Math.round(anime.score * 10) : null
                });

                const result = {
                    poster: anime.images?.jpg?.large_image_url || null,
                    background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                    description: formattedDesc,
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
