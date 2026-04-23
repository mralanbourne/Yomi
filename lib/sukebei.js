//===============
// YOMI HYBRID SCRAPING HUB (PROWLARR + DIRECT NATIVE BYPASS + EXTENDED TRACKERS)
// Inklusive geschlossener RuTracker-Integration via Session-Cookies & nativem Bencode-Parsing.
//===============

const axios = require("axios");
const crypto = require("crypto");

const PROWLARR_URL = process.env.PROWLARR_URL || "http://prowlarr:9696";
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY || null;
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;
const RUTRACKER_COOKIE = process.env.RUTRACKER_COOKIE || null;

const MIRRORS = [
    "https://sukebei.nyaa.si",
    "https://sukebei.nyaa.iss.one"
];
let currentMirrorIndex = 0;
function getNextMirror() {
    currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
    return MIRRORS[currentMirrorIndex];
}

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

let anirenaCooldownEnd = 0;

//===============
// NATIVE BENCODE EXTRAKTOR
// Zieht den sha1 Info-Hash direkt aus rohen .torrent Datei-Buffern
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
// RSS PARSER
// Flexibel gehalten für verschiedene RSS-Dialekte
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
        } else if (linkMatch && (sourceName === "AniRena Direct" || sourceName === "TokyoTosho" || sourceName === "AniDex")) {
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
// BYPASS LOGIK
//===============
async function fetchWithBypass(url, domainName) {
    if (FLARESOLVERR_URL) {
        try {
            const res = await axios.post(FLARESOLVERR_URL, { cmd: "request.get", url: url, maxTimeout: 15000 }, { timeout: 20000 });
            if (res.data && res.data.solution && res.data.solution.response) {
                console.log(`[BYPASS] 🛡️  FlareSolverr hat Cloudflare für ${domainName} erfolgreich umgangen.`);
                return { data: res.data.solution.response };
            }
        } catch (e) { 
            console.log(`[BYPASS] ⚠️  FlareSolverr Timeout/Error für ${domainName}. Falle auf nativen Request zurück.`); 
        }
    }
    return axios.get(url, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
}

//===============
// PROVIDER 1: PROWLARR
//===============
async function searchProwlarr(query) {
    if (!PROWLARR_API_KEY) {
        console.log(`[PROWLARR] ⏭️  Übersprungen (Kein API Key konfiguriert).`);
        return [];
    }
    try {
        const url = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(query)}`;
        const res = await axios.get(url, { headers: { "X-Api-Key": PROWLARR_API_KEY }, timeout: 25000 });
        
        const results = res.data.map(item => ({
            title: item.title,
            hash: item.infoHash ? item.infoHash.toLowerCase() : null,
            size: (item.size / (1024 * 1024 * 1024)).toFixed(2) + " GiB",
            seeders: item.seeders || 0,
            source: `Prowlarr (${item.indexer})`
        })).filter(t => t.hash);
        
        console.log(`[PROWLARR] ✅ Prowlarr lieferte ${results.length} Ergebnisse.`);
        return results;
    } catch (e) {
        const status = e.response ? e.response.status : "Network Error";
        console.log(`[PROWLARR] ❌ Fehler: ${status} - ${e.message}`);
        return [];
    }
}

//===============
// MAIN AGGREGATOR
//===============
async function searchSukebeiForHentai(queryOriginal) {
    if (!queryOriginal || queryOriginal.trim().length < 3) return [];

    const queryKey = queryOriginal.trim().toLowerCase();
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) {
            console.log(`[HUB] ⚡ Cache Hit für: "${queryOriginal}" (${item.data.length} Torrents)`);
            return item.data;
        }
        searchCache.delete(queryKey);
    }

    console.log(`\n[HUB] 🔍 Starte Hybrid-Suche für: "${queryOriginal}"`);
    const safeQuery = encodeURIComponent(queryOriginal);

    // Provider 2: Sukebei
    const fetchSukebei = async () => {
        let attempts = 0;
        let success = false;
        let results = [];
        while (attempts < MIRRORS.length && !success) {
            const domain = MIRRORS[currentMirrorIndex];
            const rssUrl = `${domain}/?page=rss&c=0_0&f=0&q=${safeQuery}`;
            try {
                const response = await fetchWithBypass(rssUrl, "Sukebei");
                results = parseRSS(response.data, "Sukebei Direct");
                console.log(`[SUKEBEI] ✅ Direct lieferte ${results.length} Ergebnisse.`);
                success = true;
            } catch (error) {
                console.log(`[SUKEBEI] ⚠️ Mirror ${domain} fehlgeschlagen, wechsle...`);
                getNextMirror();
                attempts++;
            }
        }
        if(!success) console.log(`[SUKEBEI] ❌ Alle Mirrors fehlgeschlagen.`);
        return results;
    };

    // Provider 3: AniRena
    const fetchAniRena = async () => {
        if (Date.now() < anirenaCooldownEnd) {
            console.log(`[ANIRENA] ⏳ Cooldown aktiv. Überspringe Suche um Ban zu vermeiden.`);
            return [];
        }
        const anirenaUrl = `https://www.anirena.com/rss?adult=1&s=${safeQuery}`;
        try {
            const response = await fetchWithBypass(anirenaUrl, "AniRena");
            let results = parseRSS(response.data, "AniRena Direct");

            const missingHashResults = results.filter(r => !r.hash && r.torrentLink);
            if (missingHashResults.length > 0) {
                let rateLimitHit = false;
                const batchSize = 1; 
                
                for (let i = 0; i < missingHashResults.length; i += batchSize) {
                    if (rateLimitHit) break; 
                    const batch = missingHashResults.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (item) => {
                        try {
                            const tRes = await axios.get(item.torrentLink, {
                                responseType: "arraybuffer", timeout: 6000,
                                headers: { "User-Agent": "Mozilla/5.0" }
                            });
                            const extractedHash = getInfoHash(tRes.data);
                            if (extractedHash) item.hash = extractedHash;
                        } catch (e) {
                            if (e.response && e.response.status === 429) {
                                rateLimitHit = true;
                                const retryAfter = e.response.headers["retry-after"] || 30;
                                anirenaCooldownEnd = Date.now() + (retryAfter * 1000);
                                console.log(`[ANIRENA] ⚠️ Bot-Schutz aktiv (429). Stoppe Downloads für ${retryAfter}s.`);
                            }
                        }
                    }));
                    if (!rateLimitHit && i + batchSize < missingHashResults.length) {
                        await new Promise(res => setTimeout(res, 1500)); 
                    }
                }
                results = results.filter(r => r.hash);
            }
            console.log(`[ANIRENA] ✅ Direct lieferte ${results.length} verifizierte Ergebnisse.`);
            return results;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const retryAfter = error.response.headers["retry-after"] || 60;
                anirenaCooldownEnd = Date.now() + (retryAfter * 1000);
                console.log(`[ANIRENA] 🚨 RSS Rate Limit (429)! Cooldown: ${retryAfter}s`);
            } else {
                console.log(`[ANIRENA] ❌ Fehler: ${error.message}`);
            }
            return []; 
        }
    };

    // Provider 4: AniDex
    const fetchAniDex = async () => {
        const anidexUrl = `https://anidex.info/rss/?q=${safeQuery}`;
        try {
            const response = await fetchWithBypass(anidexUrl, "AniDex");
            const results = parseRSS(response.data, "AniDex");
            console.log(`[ANIDEX] ✅ Direct lieferte ${results.length} Ergebnisse.`);
            return results;
        } catch (error) {
            console.log(`[ANIDEX] ❌ Fehler: ${error.message}`);
            return [];
        }
    };

    // Provider 5: TokyoTosho
    const fetchTokyoTosho = async () => {
        const tokyoToshoUrl = `https://tokyotosho.info/rss.php?terms=${safeQuery}`;
        try {
            const response = await fetchWithBypass(tokyoToshoUrl, "TokyoTosho");
            const results = parseRSS(response.data, "TokyoTosho");
            console.log(`[TOKYOTOSHO] ✅ Direct lieferte ${results.length} Ergebnisse.`);
            return results;
        } catch (error) {
            console.log(`[TOKYOTOSHO] ❌ Fehler: ${error.message}`);
            return [];
        }
    };

    // Provider 6: RuTracker (Geschlossenes System, Cookie zwingend erforderlich)
    const fetchRuTracker = async () => {
        if (!RUTRACKER_COOKIE) {
            console.log(`[RUTRACKER] ⏭️  Übersprungen (Kein RUTRACKER_COOKIE konfiguriert).`);
            return [];
        }
        try {
            const searchData = `nm=${safeQuery}`;
            const searchRes = await axios.post("https://rutracker.org/forum/tracker.php", searchData, {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": RUTRACKER_COOKIE,
                    "User-Agent": "Mozilla/5.0"
                },
                responseType: "arraybuffer",
                timeout: 12000
            });

            const html = searchRes.data.toString("binary");
            const results = [];
            const rowRegex = /<tr class="tCenter hl-tr" data-topic_id="(\d+)">([\s\S]*?)<\/tr>/g;
            let rowMatch;

            while ((rowMatch = rowRegex.exec(html)) !== null) {
                const topicId = rowMatch[1];
                const rowContent = rowMatch[2];

                let title = "";
                const titleMatch = rowContent.match(/class="[^"]*tLink[^"]*"[^>]*>([^<]+)<\/a>/);
                if (titleMatch) title = titleMatch[1].trim();

                let size = "0 B";
                const sizeMatch = rowContent.match(/data-ts_text="(\d+)"/);
                if (sizeMatch) {
                    const bytes = parseInt(sizeMatch[1], 10);
                    if (bytes >= 1073741824) size = (bytes / 1073741824).toFixed(2) + " GiB";
                    else if (bytes >= 1048576) size = (bytes / 1048576).toFixed(2) + " MiB";
                    else size = (bytes / 1024).toFixed(2) + " KiB";
                }

                let seeders = 0;
                const seedMatch = rowContent.match(/class="tor-seed"[^>]*>.*?<b[^>]*>(\d+)<\/b>/is);
                if (seedMatch) seeders = parseInt(seedMatch[1], 10);

                if (title && topicId) {
                    results.push({ title, topicId, size, seeders, source: "RuTracker" });
                }
            }

            // Extreme-Limitierung: Um Rate-Limits und Account-Banns zu verhindern, 
            // holen wir uns nur für die Top 3 geseedeten Ergebnisse die .torrent-Dateien zum Hashen.
            const topResults = results.sort((a, b) => b.seeders - a.seeders).slice(0, 3);
            const finalResults = [];

            for (const item of topResults) {
                try {
                    const dlRes = await axios.get(`https://rutracker.org/forum/dl.php?t=${item.topicId}`, {
                        headers: { "Cookie": RUTRACKER_COOKIE, "User-Agent": "Mozilla/5.0" },
                        responseType: "arraybuffer",
                        timeout: 6000
                    });
                    const hash = getInfoHash(dlRes.data);
                    if (hash) {
                        finalResults.push({
                            title: item.title,
                            hash: hash,
                            torrentLink: `magnet:?xt=urn:btih:${hash}`,
                            size: item.size,
                            seeders: item.seeders,
                            source: "RuTracker"
                        });
                    }
                } catch(e) {}
                await new Promise(r => setTimeout(r, 1200)); 
            }

            console.log(`[RUTRACKER] ✅ RuTracker lieferte ${finalResults.length} verifizierte Hashes.`);
            return finalResults;

        } catch (error) {
            console.log(`[RUTRACKER] ❌ Fehler: ${error.message}`);
            return [];
        }
    };

    // Parallel-Ausführung mit robuster Promise.allSettled Isolation
    const tasks = [
        searchProwlarr(queryOriginal),
        fetchSukebei(),
        fetchAniRena(),
        fetchAniDex(),
        fetchTokyoTosho(),
        fetchRuTracker()
    ];

    const results = await Promise.allSettled(tasks);
    
    const prowlarrRes = results[0].status === "fulfilled" ? results[0].value : [];
    const sukebeiRes = results[1].status === "fulfilled" ? results[1].value : [];
    const anirenaRes = results[2].status === "fulfilled" ? results[2].value : [];
    const anidexRes = results[3].status === "fulfilled" ? results[3].value : [];
    const tokyotoshoRes = results[4].status === "fulfilled" ? results[4].value : [];
    const rutrackerRes = results[5].status === "fulfilled" ? results[5].value : [];

    console.log(`[HUB-STATS] 📊 Prowlarr: ${prowlarrRes.length} | Sukebei: ${sukebeiRes.length} | AniRena: ${anirenaRes.length} | AniDex: ${anidexRes.length} | TokyoTosho: ${tokyotoshoRes.length} | RuTracker: ${rutrackerRes.length}`);

    const allResults = [...prowlarrRes, ...sukebeiRes, ...anirenaRes, ...anidexRes, ...tokyotoshoRes, ...rutrackerRes];

    const unique = new Map();
    allResults.forEach(t => {
        if (!unique.has(t.hash) || t.seeders > unique.get(t.hash).seeders) {
            unique.set(t.hash, t);
        }
    });

    const finalArr = Array.from(unique.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[HUB] 🏆 Gesamt nach Deduplizierung: ${finalArr.length} Torrents.`);
    
    if (finalArr.length > 0) {
        searchCache.set(queryKey, { data: finalArr, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return finalArr;
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

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
