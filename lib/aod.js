//===============
// YOMI ANIME OFFLINE DATABASE (AOD)
// Holt dynamisch die neueste Release-URL via GitHub API, 
// lädt sie herunter und baut die Alias-Map auf.
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
        
        // Cache fehlt oder ist abgelaufen -> Dynamisch von GitHub Releases laden
        if (!data) {
            console.log("[AOD] Suche nach dem neuesten Release via GitHub API...");
            
            // 1. Hole die Metadaten des neuesten Releases
            const releaseRes = await axios.get(GITHUB_API_URL, { timeout: 10000 });
            const assets = releaseRes.data.assets;
            
            // 2. Finde die korrekte Datei in den Assets
            const targetAsset = assets.find(a => a.name === "anime-offline-database-minified.json");
            
            if (!targetAsset) {
                throw new Error("Minified JSON wurde im neuesten GitHub Release nicht gefunden.");
            }
            
            console.log(`[AOD] Release gefunden! Lade Datei von: ${targetAsset.browser_download_url}`);
            
            // 3. Lade die eigentliche JSON herunter (Timeout großzügig wegen 50+ MB Dateigröße)
            const fileRes = await axios.get(targetAsset.browser_download_url, { 
                responseType: "text",
                timeout: 60000 
            }); 
            
            data = typeof fileRes.data === "string" ? JSON.parse(fileRes.data) : fileRes.data;
            
            // Auf der Festplatte zwischenspeichern
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

// Background-Init starten
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
