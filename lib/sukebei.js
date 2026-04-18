//===============
// YOMI DUAL-SCRAPER ENGINE (SUKEBEI + ANIRENA NSFW)
// Hochrobuste Live-Version.
// Nutzt Promise.allSettled, damit Sukebei immer liefert, selbst wenn AniRena durch Cloudflare blockiert wird.
//===============

const axios = require("axios");
const crypto = require("crypto");

const MIRRORS = [
    "https://sukebei.nyaa.si",
    "https://sukebei.nyaa.iss.one",
    "https://sukebei.nyaa.land",
    "https://sukebei.nyaa.tracker.wf"
];

let currentMirrorIndex = 0;
function getNextMirror() {
    currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
    return MIRRORS[currentMirrorIndex];
}

//===============
// IN-MEMORY CACHE & QUEUE STATE
// Verhindert Tracker-Spam bei identischen Suchanfragen.
//===============
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 Minuten

const domainQueues = {
    "sukebei": 0,
    "anirena": 0
};

// Globaler Cooldown-Timer fuer AniRena, falls ein 429 Fehler auftritt.
let anirenaCooldownEnd = 0;

async function fetchWithDomainQueue(url, domain, delayMs) {
    const now = Date.now();
    const timeToWait = Math.max(0, domainQueues[domain] + delayMs - now);
    
    domainQueues[domain] = now + timeToWait; 
    
    if (timeToWait > 0) {
        await new Promise(res => setTimeout(res, timeToWait));
    }
    
    return axios.get(url, {
        timeout: 10000,
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/rss+xml, text/xml, */*"
        }
    });
}

function cleanTorrentTitle(title) {
    let clean = title;
    clean = clean.replace(/\[.*?\]/g, "");
    clean = clean.replace(/\(.*?\)/g, "");
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, "");
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, "");
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, "");
    clean = clean.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
    return clean || title; 
}

//===============
// NATIVE BENCODE EXTRAKTOR
// Keine externen Pakete, liest direkt den SHA-1 Hash aus dem ArrayBuffer.
//===============
function getInfoHash(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;
    const infoIndex = buffer.indexOf(Buffer.from("4:info"));
    if (infoIndex === -1) return null;
    
    const start = infoIndex + 6;
    let i = start;
    
    function skip() {
        if (i >= buffer.length) return;
        const char = buffer[i];
        if (char === 0x69) {
            i++;
            while(buffer[i] !== 0x65 && i < buffer.length) i++;
            i++;
        } else if (char === 0x6c || char === 0x64) {
            i++;
            while(buffer[i] !== 0x65 && i < buffer.length) skip();
            i++;
        } else if (char >= 0x30 && char <= 0x39) {
            let colon = i;
            while(buffer[colon] !== 0x3a && colon < buffer.length) colon++;
            const len = parseInt(buffer.toString("utf8", i, colon), 10);
            i = colon + 1 + len;
        } else {
            throw new Error("Bencode Error");
        }
    }
    
    try {
        skip();
        const infoBuffer = buffer.slice(start, i);
        return crypto.createHash("sha1").update(infoBuffer).digest("hex");
    } catch(e) {
        return null;
    }
}

//===============
// ROBUSTER RSS XML PARSER
//===============
function parseRSS(xml, sourceName) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];

        let title = "";
        const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        if (titleMatch) title = titleMatch[1].trim();

        let hash = "";
        const hashMatch = itemXml.match(/(?:infoHash>|urn:btih:)([a-fA-F0-9]{40})/i);
        if (hashMatch) hash = hashMatch[1].toLowerCase();

        let torrentLink = "";
        const enclosureMatch = itemXml.match(/<enclosure\s+url="([^"]+\.torrent)"/i);
        const linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?([^<]+)(?:\]\]>)?<\/link>/i);
        
        if (enclosureMatch) {
            torrentLink = enclosureMatch[1];
        } else if (linkMatch && linkMatch[1].includes(".torrent")) {
            torrentLink = linkMatch[1];
        } else if (linkMatch && sourceName === "AniRena") {
            torrentLink = linkMatch[1]; 
        }

        let size = "0 B";
        const sizeMatchNyaa = itemXml.match(/<(?:nyaa:size|size)>([\s\S]*?)<\/(?:nyaa:size|size)>/);
        const sizeMatchTor = itemXml.match(/<torrent:contentLength>(\d+)<\/torrent:contentLength>/);
        const sizeMatchDesc = itemXml.match(/Size:\s*([\d.]+\s*[KMG]?i?B)/i);

        if (sizeMatchNyaa) {
            size = sizeMatchNyaa[1];
        } else if (sizeMatchTor) {
            const bytes = parseInt(sizeMatchTor[1], 10);
            if (bytes >= 1073741824) size = (bytes / 1073741824).toFixed(2) + " GiB";
            else if (bytes >= 1048576) size = (bytes / 1048576).toFixed(2) + " MiB";
            else size = (bytes / 1024).toFixed(2) + " KiB";
        } else if (sizeMatchDesc) {
            size = sizeMatchDesc[1];
        }

        let seeders = 0;
        const seedMatchNyaa = itemXml.match(/<(?:nyaa:seeders|seeders)>(\d+)<\/(?:nyaa:seeders|seeders)>/);
        const seedMatchTor = itemXml.match(/<torrent:seeds>(\d+)<\/torrent:seeds>/);
        const seedMatchStats = itemXml.match(/S:\s*(\d+)/i); 

        if (seedMatchNyaa) seeders = parseInt(seedMatchNyaa[1], 10);
        else if (seedMatchTor) seeders = parseInt(seedMatchTor[1], 10);
        else if (seedMatchStats) seeders = parseInt(seedMatchStats[1], 10);

        if (title && (hash || torrentLink)) {
            items.push({
                title: title, 
                hash: hash,
                torrentLink: torrentLink,
                size: size,
                seeders: seeders,
                source: sourceName
            });
        }
    }
    return items;
}

//===============
// MAIN EXPORT: HIGH-AVAILABILITY LIVE AGGREGATOR
//===============
async function searchSukebeiForHentai(queryOriginal) {
    if (!queryOriginal || queryOriginal.trim().length < 3) return [];

    const queryKey = queryOriginal.trim().toLowerCase();
    
    // Memory Cache Check
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) {
            console.log(`[CACHE HIT] 🚀 Lade Ergebnisse fuer "${queryOriginal}" aus dem Arbeitsspeicher.`);
            return item.data;
        }
        searchCache.delete(queryKey);
    }

    console.log(`\n[MULTI-SCRAPER] 🔍 Bereite Live-Suche vor für: "${queryOriginal.trim()}"`);

    const queries = [queryOriginal.trim()];
    const delimiters = /[:!\-~]/;
    if (delimiters.test(queryOriginal)) {
        const shortTitle = queryOriginal.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) queries.push(shortTitle);
    }

    let allResults = [];

    for (const query of queries) {
        console.log(`[MULTI-SCRAPER] 🚀 Starte Sub-Query: "${query}"`);
        const safeQuery = encodeURIComponent(query);

        // 1. Sukebei-Suche (Unabhaengig und robust)
        const fetchSukebei = async () => {
            let attempts = 0;
            let success = false;
            let results = [];
            while (attempts < MIRRORS.length && !success) {
                const domain = MIRRORS[currentMirrorIndex];
                const rssUrl = `${domain}/?page=rss&c=0_0&f=0&q=${safeQuery}`;
                try {
                    const response = await fetchWithDomainQueue(rssUrl, "sukebei", 800);
                    results = parseRSS(response.data, "Sukebei");
                    console.log(`[SCRAPER] ✅ Sukebei (${domain}) lieferte ${results.length} Roh-Ergebnisse.`);
                    success = true;
                } catch (error) {
                    getNextMirror();
                    attempts++;
                }
            }
            return results;
        };

        // 2. AniRena-Suche (Mit Hard-Fail Sicherung)
        const fetchAniRena = async () => {
            if (Date.now() < anirenaCooldownEnd) {
                console.log(`[ANI-DEBUG] ⏳ AniRena befindet sich im Cooldown. Ueberspringe anfrage fuer "${query}".`);
                return []; // Sofortiger Fallback
            }

            const anirenaUrl = `https://www.anirena.com/rss?adult=1&s=${safeQuery}`;
            try {
                const response = await fetchWithDomainQueue(anirenaUrl, "anirena", 1500);
                let results = parseRSS(response.data, "AniRena");

                const missingHashResults = results.filter(r => !r.hash && r.torrentLink);
                if (missingHashResults.length > 0) {
                    const batchSize = 2; 
                    let rateLimitHit = false;

                    for (let i = 0; i < missingHashResults.length; i += batchSize) {
                        if (rateLimitHit) break; // Bisher gefundene Hashes werden behalten, Rest ignoriert.

                        const batch = missingHashResults.slice(i, i + batchSize);
                        await Promise.all(batch.map(async (item) => {
                            try {
                                const tRes = await axios.get(item.torrentLink, {
                                    responseType: "arraybuffer",
                                    timeout: 6000,
                                    headers: { "User-Agent": "Mozilla/5.0" }
                                });
                                const extractedHash = getInfoHash(tRes.data);
                                if (extractedHash) item.hash = extractedHash;
                            } catch (e) {
                                if (e.response && e.response.status === 429) {
                                    rateLimitHit = true;
                                    const retryAfter = e.response.headers["retry-after"] || 60;
                                    anirenaCooldownEnd = Date.now() + (retryAfter * 1000);
                                    console.log(`[ANI-DEBUG] 🚨 RATE LIMIT (429) bei AniRena Torrent Download. Setze Cooldown fuer ${retryAfter}s.`);
                                }
                            }
                        }));
                        
                        if (!rateLimitHit && i + batchSize < missingHashResults.length) {
                            await new Promise(res => setTimeout(res, 500)); // Sanfte Pause
                        }
                    }
                    // Wir filtern nur die heraus, die im Endeffekt einen Hash haben.
                    results = results.filter(r => r.hash);
                }
                console.log(`[SCRAPER] ✅ AniRena lieferte ${results.length} verifizierte Ergebnisse.`);
                return results;

            } catch (error) {
                if (error.response && error.response.status === 429) {
                    const retryAfter = error.response.headers["retry-after"] || 60;
                    anirenaCooldownEnd = Date.now() + (retryAfter * 1000);
                    console.log(`[ANI-DEBUG] ❌ HTTP 429 bei AniRena Feed Anfrage. Setze Cooldown fuer ${retryAfter}s.`);
                } else {
                    console.log(`[ANI-DEBUG] ❌ AniRena Fehler: ${error.message}`);
                }
                return []; // Rückgabe einer leeren Liste anstelle eines Crashes
            }
        };

        // Das Herzstueck der Robustheit: Promise.allSettled
        // Es wartet auf beide Scraper, aber wenn einer hart abstuerzt, werden die Daten des anderen trotzdem verwertet.
        const scraperPromises = await Promise.allSettled([
            fetchSukebei(),
            fetchAniRena()
        ]);

        const sukebeiRes = scraperPromises[0].status === "fulfilled" ? scraperPromises[0].value : [];
        const anirenaRes = scraperPromises[1].status === "fulfilled" ? scraperPromises[1].value : [];

        allResults.push(...sukebeiRes, ...anirenaRes);
    }

    // Deduplizierung über Hash (Der Seed-Staerkere gewinnt)
    const uniqueResults = new Map();
    allResults.forEach(t => {
        if (!uniqueResults.has(t.hash)) {
            uniqueResults.set(t.hash, t);
        } else {
            if (t.seeders > uniqueResults.get(t.hash).seeders) {
                uniqueResults.set(t.hash, t);
            }
        }
    });

    const finalArr = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[SCRAPER] 🏆 Gesamt nach Deduplizierung: ${finalArr.length} Torrents für den Parser bereit.`);
    
    // In den Memory Cache speichern
    if (finalArr.length > 0) {
        searchCache.set(queryKey, { data: finalArr, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return finalArr;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
