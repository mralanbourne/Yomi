const axios = require('axios');

const ANILIST_URL = 'https://graphql.anilist.co';

async function _fetchAniList(query, variables) {
    try {
        const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
        if (!response.data || !response.data.data || !response.data.data.Page) return [];
        
        return response.data.data.Page.media.map(anime => {
            const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
            const base64Title = Buffer.from(cleanTitle).toString('base64url');
            
            return {
                id: `anilist:${anime.id}:${base64Title}`,
                type: 'series', // FIX: Erzwingt das Serien-Layout für Stremio!
                name: cleanTitle,
                poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                background: anime.bannerImage || "",
                description: anime.description || "No description available.",
                episodes: anime.episodes || 1
            };
        });
    } catch (error) {
        console.error("[AniList] Fetch Error:", error.message);
        return [];
    }
}

async function searchAdultAnime(query) {
    if (!query || query.length < 3) return [];
    const graphqlQuery = `query ($search: String) { Page(page: 1, perPage: 50) { media(search: $search, type: ANIME, isAdult: true) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

async function getTrendingAdultAnime() {
    const graphqlQuery = `query { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: TRENDING_DESC) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, {});
}

async function getTopAdultAnime() {
    const graphqlQuery = `query { Page(page: 1, perPage: 30) { media(type: ANIME, isAdult: true, sort: SCORE_DESC) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } } }`;
    return _fetchAniList(graphqlQuery, {});
}

async function getAnimeMeta(anilistId) {
    const graphqlQuery = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english } coverImage { extraLarge } bannerImage description format episodes } }`;
    try {
        const response = await axios.post(ANILIST_URL, { query: graphqlQuery, variables: { id: parseInt(anilistId) } }, { timeout: 6000 });
        const anime = response.data?.data?.Media;
        if (!anime) return null;

        const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
        const base64Title = Buffer.from(cleanTitle).toString('base64url');

        return {
            id: `anilist:${anime.id}:${base64Title}`,
            type: 'series', // FIX: Erzwingt das Serien-Layout!
            name: cleanTitle,
            poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
            background: anime.bannerImage || "",
            description: anime.description || "No description available.",
            episodes: anime.episodes || 1
        };
    } catch (error) {
        console.error("[AniList] Meta Error:", error.message);
        return null;
    }
}

module.exports = { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime };
