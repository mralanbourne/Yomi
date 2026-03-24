const axios = require('axios');

const ANILIST_URL = 'https://graphql.anilist.co';

// Standardized fetch logic for AniList.
// Safeguards against null crashes when AniList blocks specific words.
async function _fetchAniList(query, variables) {
    try {
        const response = await axios.post(ANILIST_URL, {
            query: query,
            variables: variables
        }, { timeout: 6000 });

        // If AniList returns a GraphQL Error, response.data.data is often null.
        if (!response.data || !response.data.data || !response.data.data.Page) {
            return [];
        }

        const mediaList = response.data.data.Page.media;
        
        return mediaList.map(anime => {
            const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
            const base64Title = Buffer.from(cleanTitle).toString('base64url');
            
            return {
                id: `anilist:${anime.id}:${base64Title}`,
                type: anime.format === 'MOVIE' ? 'movie' : 'series',
                name: cleanTitle,
                poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                background: anime.bannerImage || "",
                description: anime.description || "No description available."
            };
        });
    } catch (error) {
        console.error("[AniList] Fetch Error:", error.message);
        return [];
    }
}

async function searchAdultAnime(query) {
    // Guard Clause against Stremio's auto-search spam
    if (!query || query.length < 3) return [];

    const graphqlQuery = `
    query ($search: String) {
        Page(page: 1, perPage: 50) {
            media(search: $search, type: ANIME, isAdult: true) {
                id title { romaji english } coverImage { extraLarge } bannerImage description format
            }
        }
    }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

// Fetches the currently most popular 18+ anime for the Trending list
async function getTrendingAdultAnime() {
    const graphqlQuery = `
    query {
        Page(page: 1, perPage: 30) {
            media(type: ANIME, isAdult: true, sort: TRENDING_DESC) {
                id title { romaji english } coverImage { extraLarge } bannerImage description format
            }
        }
    }`;
    return _fetchAniList(graphqlQuery, {});
}

// Fetches the highest rated 18+ anime for the Top Rated list
async function getTopAdultAnime() {
    const graphqlQuery = `
    query {
        Page(page: 1, perPage: 30) {
            media(type: ANIME, isAdult: true, sort: SCORE_DESC) {
                id title { romaji english } coverImage { extraLarge } bannerImage description format
            }
        }
    }`;
    return _fetchAniList(graphqlQuery, {});
}

async function getAnimeMeta(anilistId) {
    const graphqlQuery = `
    query ($id: Int) {
        Media(id: $id, type: ANIME) {
            id title { romaji english } coverImage { extraLarge } bannerImage description format
        }
    }`;

    try {
        const response = await axios.post(ANILIST_URL, {
            query: graphqlQuery,
            variables: { id: parseInt(anilistId) }
        }, { timeout: 6000 });

        const anime = response.data?.data?.Media;
        if (!anime) return null;

        const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
        const base64Title = Buffer.from(cleanTitle).toString('base64url');

        return {
            id: `anilist:${anime.id}:${base64Title}`,
            type: anime.format === 'MOVIE' ? 'movie' : 'series',
            name: cleanTitle,
            poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
            background: anime.bannerImage || "",
            description: anime.description || "No description available."
        };
    } catch (error) {
        console.error("[AniList] Meta Error:", error.message);
        return null;
    }
}

module.exports = { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime };
