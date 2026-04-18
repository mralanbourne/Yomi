//===============
// YOMI ANIME OFFLINE DATABASE (AOD)
// Lädt die AOD-Datenbank asynchron herunter, cacht sie lokal und 
// baut eine in-memory Map für blitzschnelle Synonym-Suchen auf.
//===============

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const AOD_URL = "https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json";
const CACHE_FILE = path.join(__dirname, "../aod-cache.json");

let aodData = {
    anilist: new Map(),
    title: new Map()
};

let isReady = false;

async function initAOD() {
    console.log("[AOD] Initialisiere Anime Offline Database (Auto-Aliasing)...");
    let data;
    try {
        // Prüfe auf lokalen Cache (Maximal 7 Tage alt)
        if (fs.existsSync(CACHE_FILE)) {
            const stats = fs.statSync(CACHE_FILE);
            if (Date.now() - stats.mtimeMs < 7 * 24 * 60 * 60 * 1000) {
                console.log("[AOD] Lade lokale Datenbank aus dem Cache...");
                const raw = fs.readFileSync(CACHE_FILE, "utf-8");
                data = JSON.parse(raw);
            }
        }
        
        // Cache fehlt oder ist abgelaufen -> Lade neu von GitHub
        if (!data) {
            console.log("[AOD] Lade neueste Datenbank von GitHub (ca. 30MB) herunter...");
            const res = await axios.get(AOD_URL, { 
                responseType: "text",
                timeout: 30000 
            }); 
            data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
            console.log("[AOD] Download und Cache erfolgreich gesichert.");
        }

        if (data && data.data) {
            data.data.forEach(anime => {
                const synonyms = anime.synonyms || [];
                let anilistId = null;
                
                // Extrahieren der AniList ID aus den verknüpften Quellen
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
            console.log(`[AOD] Datenbank geladen. ${aodData.anilist.size} AniList-Verknüpfungen für Aliase erstellt.`);
        }
    } catch (e) {
        console.error("[AOD] SCHWERER FEHLER beim Initialisieren der Datenbank:", e.message);
    }
}

// Background-Init starten, blockiert nicht den Addon-Start
initAOD();

function getAliasesByAniListId(id) {
    if (!isReady || !id) return [];
    return aodData.anilist.get(id.toString()) || [];
}

function getAliasesByTitle(title) {
    if (!isReady || !title) return [];
    return aodData.title.get(title.toLowerCase()) || [];
}

module.exports = { getAliasesByAniListId, getAliasesByTitle, isReady };
