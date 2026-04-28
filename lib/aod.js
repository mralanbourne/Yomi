//===============
// YOMI ANIME OFFLINE DATABASE (AOD)
// Dynamically fetches the latest release URL via GitHub API, downloads it, and builds the alias map in RAM.
// Critical for matching official English titles against underground Japanese file names.
//===============

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const GITHUB_API_URL = "https://api.github.com/repos/manami-project/anime-offline-database/releases/latest";
const CACHE_FILE = path.join(__dirname, "../aod-cache.json");

let aodData = {
    anilist: new Map(),
    title: new Map()
};

let isReady = false;

//===============
// AOD INITIALIZER
// Attempts to load from the local cache file, and dynamically downloads the latest payload 
// directly from GitHub if it is missing or older than 7 days.
//===============
async function initAOD() {
    console.log("[AOD] Initializing Anime Offline Database (Auto-Aliasing)...");
    let data;
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const stats = fs.statSync(CACHE_FILE);
            if (Date.now() - stats.mtimeMs < 7 * 24 * 60 * 60 * 1000) {
                const raw = fs.readFileSync(CACHE_FILE, "utf-8");
                data = JSON.parse(raw);
            }
        }
        
        if (!data) {
            const releaseRes = await axios.get(GITHUB_API_URL, { timeout: 10000 });
            const assets = releaseRes.data.assets;
            const targetAsset = assets.find(a => a.name === "anime-offline-database-minified.json");
            
            if (!targetAsset) {
                throw new Error("Minified JSON was not found in the latest GitHub Release.");
            }
            
            const fileRes = await axios.get(targetAsset.browser_download_url, { 
                responseType: "text",
                timeout: 60000 
            }); 
            
            data = typeof fileRes.data === "string" ? JSON.parse(fileRes.data) : fileRes.data;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
        }

        if (data && data.data) {
            data.data.forEach(anime => {
                const synonyms = anime.synonyms || [];
                let anilistId = null;
                
                if (anime.sources) {
                    anime.sources.forEach(src => {
                        const match = src.match(/anilist\.co\/anime\/(\d+)/);
                        if (match) anilistId = match[1];
                    });
                }

                if (anilistId) {
                    aodData.anilist.set(anilistId, synonyms);
                }
                
                if (anime.title) {
                    aodData.title.set(anime.title.toLowerCase(), synonyms);
                }
            });
            isReady = true;
        }
    } catch (e) {
        console.error("[AOD] FATAL ERROR during database initialization:", e.message);
    }
}

// Trigger background initialization immediately
initAOD();

// Gets the list of synonym variations directly tied to an AniList numerical identifier
function getAliasesByAniListId(id) {
    if (!isReady || !id) return [];
    return aodData.anilist.get(id.toString()) || [];
}

// Reverses the process, fetching aliases based on textual matches
function getAliasesByTitle(title) {
    if (!isReady || !title) return [];
    return aodData.title.get(title.toLowerCase()) || [];
}

module.exports = { getAliasesByAniListId, getAliasesByTitle, isReady };
