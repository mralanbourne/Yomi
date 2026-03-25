const axios = require('axios');

const ANILIST_URL = 'https://graphql.anilist.co';

// ============================================================================
// CACHE & RATE LIMITING SCHUTZ
// Verhindert "429 Too Many Requests" durch RAM-Caching und Exponential Backoff.
// Einmal abgerufene Daten bleiben für 6 Stunden im Speicher (Max 500 Einträge).
// ============================================================================
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 Stunden Cache-Dauer in Millisekunden

/**
 * Hilfsfunktion für den Backoff (Zwingt den Prozess zu pausieren)
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generischer Fetcher für AniList mit Retry-Logik und Caching.
 */
async function _fetchAniList(query, variables, retries = 3) {
    const cacheKey = `anilist_${JSON.stringify(variables || {})}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
            if (!response.data || !response.data.data || !response.data.data.Page) return [];
            
            const results = response.data.data.Page.media.map(anime => {
                const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                const base64Title = Buffer.from(cleanTitle).toString('base64url');
                
                return {
                    id: `anilist:${anime.id}:${base64Title}`,
                    type: 'series', 
                    name: cleanTitle,
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "",
                    description: anime.description || "No description available.",
                    episodes: anime.episodes || 1
                };
            });

            // Speichern im Cache (max. 500 Einträge, um RAM auf Koyeb Free Tier zu schonen)
            apiCache.set(cacheKey, { timestamp: Date.now(), data: results });
            if (apiCache.size > 500) apiCache.clear();

            return results;

        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[AniList] Fetch Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            if (attempt === retries - 1) return []; // Letzter Versuch fehlgeschlagen
            
            // Backoff: Bei 429 warten wir exponentiell länger (2s, dann 4s, dann 6s)
            const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
            await sleep(waitTime);
        }
    }
    return [];
}

async function searchAdultAnime(query) {
    if (!query || query.length < 3) return [];
    const graphqlQuery = `query ($search: String) { Page(page: 1, perPage: 50) { media(search: $search, type: ANIME, isAdult: true) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

async function getTrendingAdultAnime() {
    const graphqlQuery = `query { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: TRENDING_DESC) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, { type: "trending" });
}

async function getTopAdultAnime() {
    const graphqlQuery = `query { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: SCORE_DESC) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, { type: "top" });
}

async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = `anilist_meta_${anilistId}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    const graphqlQuery = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } }`;
    
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
            if (apiCache.size > 500) apiCache.clear();

            return result;

        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[AniList] Meta Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            if (attempt === retries - 1) return null;
            
            const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
            await sleep(waitTime);
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// MYANIMELIST (JIKAN API) - EXTREM SCHARFES RATELIMIT (3 req/sek)
// -----------------------------------------------------------------------------
async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = `jikan_${cleanedTitle}`;
    const cachedItem = apiCache.get(cacheKey);
    if (cachedItem && (Date.now() - cachedItem.timestamp < CACHE_TTL)) {
        return cachedItem.data;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // sfw=false erlaubt explizit 18+ Suchergebnisse in der MyAnimeList-Datenbank
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
                if (apiCache.size > 500) apiCache.clear();

                return result;
            }
            return null; // Nichts Relevantes gefunden
        } catch (error) {
            const status = error.response ? error.response.status : 'Network';
            console.error(`[Jikan MAL] Fallback Error (Attempt ${attempt + 1}/${retries}): Status ${status}`);
            
            if (attempt === retries - 1) return null;
            
            const waitTime = (status === 429) ? 3000 * (attempt + 1) : 1000;
            await sleep(waitTime);
        }
    }
    return null;
}

module.exports = { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getJikanMeta };
