//===============
// YOMI HYBRID SCRAPING HUB
// Geschuetzt durch AsyncQueue zur Praevention von Tracker-IP-Banns unter Last.
//===============

const axios = require("axios");
const crypto = require("crypto");

class AsyncQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                this.running++;
                try { resolve(await task()); }
                catch(e) { reject(e); }
                finally {
                    this.running--;
                    this.dequeue();
                }
            });
            this.dequeue();
        });
    }
    dequeue() {
        if (this.running < this.concurrency && this.queue.length > 0) {
            const nextTask = this.queue.shift();
            nextTask();
        }
    }
}

// Max. 3 parallele Scrape-Anfragen weltweit, um Timeouts bei FlareSolverr zu stoppen
const scrapeQueue = new AsyncQueue(3);

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
        
        if (enclosureMatch) torrentLink = enclosureMatch[1];
        else if (linkMatch && linkMatch[1].includes(".torrent")) torrentLink = linkMatch[1];
        else if (linkMatch && (sourceName === "AniRena Direct" || sourceName === "TokyoTosho" || sourceName === "AniDex")) torrentLink = linkMatch[1];

        let size = "0 B";
        const sizeMatchNyaa = itemXml.match(/<(?:nyaa:size|size)>([\s\S]*?)<\/(?:nyaa:size|size)>/);
        const sizeMatchTor = itemXml.match(/<torrent:contentLength>(\d+)<\/torrent:contentLength>/);
        const sizeMatchDesc = itemXml.match(/Size:\s*([\d.]+\s*[KMG]?i?B)/i);

        if (sizeMatchNyaa) size = sizeMatchNyaa[1];
        else if (sizeMatchTor) {
            const bytes = parseInt(sizeMatchTor[1], 10);
            if (bytes >= 1073741824) size = (bytes / 1073741824).toFixed(2) + " GiB";
            else if (bytes >= 1048576) size = (bytes / 1048576).toFixed(2) + " MiB";
            else size = (bytes / 1024).toFixed(2) + " KiB";
        } else if (sizeMatchDesc) size = sizeMatchDesc[1];

        let seeders = 0;
        const seedMatchNyaa = itemXml.match(/<(?:nyaa:seeders|seeders)>(\d+)<\/(?:nyaa:seeders|seeders)>/);
        const seedMatchTor = itemXml.match(/<torrent:seeds>(\d+)<\/torrent:seeds>/);
        const seedMatchStats = itemXml.match(/S:\s*(\d+)/i); 

        if (seedMatchNyaa) seeders = parseInt(seedMatchNyaa[1], 10);
        else if (seedMatchTor) seeders = parseInt(seedMatchTor[1], 10);
        else if (seedMatchStats) seeders = parseInt(seedMatchStats[1], 10);

        if (title && (hash || torrentLink)) {
            items.push({ title, hash, torrentLink, size, seeders, source: sourceName });
        }
    }
    return items;
}

//===============
// BYPASS LOGIK MIT QUEUE
//===============
async function fetchWithBypass(url, domainName) {
    return scrapeQueue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 600)); // Hartes Global-Cooldown gegen Cloudflare Timeouts
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
    });
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

    const fetchSukebei = async () => {
        let attempts = 0, success = false, results = [];
        while (attempts < MIRRORS.length && !success) {
            const domain = MIRRORS[currentMirrorIndex];
            try {
                const response = await fetchWithBypass(`${domain}/?page=rss&c=0_0&f=0&q=${safeQuery}`, "Sukebei");
                results = parseRSS(response.data, "Sukebei Direct");
                console.log(`[SUKEBEI] ✅ Direct lieferte ${results.length} Ergebnisse.`);
                success = true;
            } catch (error) {
                console.log(`[SUKEBEI] ⚠️ Mirror ${domain} fehlgeschlagen, wechsle...`);
                getNextMirror();
                attempts++;
            }
        }
        return results;
    };

    const fetchAniRena = async () => {
        if (Date.now() < anirenaCooldownEnd) return [];
        try {
            const response = await fetchWithBypass(`https://www.anirena.com/rss?adult=1&s=${safeQuery}`, "AniRena");
            let results = parseRSS(response.data, "AniRena Direct");
            const missingHash = results.filter(r => !r.hash && r.torrentLink);
            
            if (missingHash.length > 0) {
                for (let i = 0; i < missingHash.length; i++) {
                    await scrapeQueue.enqueue(async () => {
                        try {
                            const tRes = await axios.get(missingHash[i].torrentLink, { responseType: "arraybuffer", timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } });
                            const extractedHash = getInfoHash(tRes.data);
                            if (extractedHash) missingHash[i].hash = extractedHash;
                            await new Promise(r => setTimeout(r, 400));
                        } catch (e) {}
                    });
                }
                results = results.filter(r => r.hash);
            }
            console.log(`[ANIRENA] ✅ Direct lieferte ${results.length} verifizierte Ergebnisse.`);
            return results;
        } catch (error) { return []; }
    };

    const fetchAniDex = async () => {
        try {
            const response = await fetchWithBypass(`https://anidex.info/rss/?q=${safeQuery}`, "AniDex");
            const results = parseRSS(response.data, "AniDex");
            console.log(`[ANIDEX] ✅ Direct lieferte ${results.length} Ergebnisse.`);
            return results;
        } catch (error) { return []; }
    };

    const fetchTokyoTosho = async () => {
        try {
            const response = await fetchWithBypass(`https://tokyotosho.info/rss.php?terms=${safeQuery}`, "TokyoTosho");
            const results = parseRSS(response.data, "TokyoTosho");
            console.log(`[TOKYOTOSHO] ✅ Direct lieferte ${results.length} Ergebnisse.`);
            return results;
        } catch (error) { return []; }
    };

    const fetchRuTracker = async () => {
        if (!RUTRACKER_COOKIE) return [];
        return scrapeQueue.enqueue(async () => {
            try {
                const searchRes = await axios.post("https://rutracker.org/forum/tracker.php", `nm=${safeQuery}`, {
                    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": RUTRACKER_COOKIE, "User-Agent": "Mozilla/5.0" },
                    responseType: "arraybuffer", timeout: 12000
                });

                const html = searchRes.data.toString("binary");
                const results = [];
                const rowRegex = /<tr class="tCenter hl-tr" data-topic_id="(\d+)">([\s\S]*?)<\/tr>/g;
                let rowMatch;

                while ((rowMatch = rowRegex.exec(html)) !== null) {
                    let title = "", size = "0 B", seeders = 0;
                    const titleMatch = rowMatch[2].match(/class="[^"]*tLink[^"]*"[^>]*>([^<]+)<\/a>/);
                    if (titleMatch) title = titleMatch[1].trim();
                    const sizeMatch = rowMatch[2].match(/data-ts_text="(\d+)"/);
                    if (sizeMatch) size = sizeMatch[1] + " Bytes"; // Vereinfacht fuer Logik
                    const seedMatch = rowMatch[2].match(/class="tor-seed"[^>]*>.*?<b[^>]*>(\d+)<\/b>/is);
                    if (seedMatch) seeders = parseInt(seedMatch[1], 10);
                    if (title && rowMatch[1]) results.push({ title, topicId: rowMatch[1], size, seeders, source: "RuTracker" });
                }

                const topResults = results.sort((a, b) => b.seeders - a.seeders).slice(0, 3);
                const finalResults = [];
                for (const item of topResults) {
                    try {
                        const dlRes = await axios.get(`https://rutracker.org/forum/dl.php?t=${item.topicId}`, { headers: { "Cookie": RUTRACKER_COOKIE, "User-Agent": "Mozilla/5.0" }, responseType: "arraybuffer", timeout: 6000 });
                        const hash = getInfoHash(dlRes.data);
                        if (hash) finalResults.push({ title: item.title, hash: hash, torrentLink: `magnet:?xt=urn:btih:${hash}`, size: item.size, seeders: item.seeders, source: "RuTracker" });
                    } catch(e) {}
                    await new Promise(r => setTimeout(r, 1200)); 
                }
                console.log(`[RUTRACKER] ✅ RuTracker lieferte ${finalResults.length} verifizierte Hashes.`);
                return finalResults;
            } catch (error) { return []; }
        });
    };

    const tasks = [ fetchSukebei(), fetchAniRena(), fetchAniDex(), fetchTokyoTosho(), fetchRuTracker() ];
    const results = await Promise.allSettled(tasks);
    
    const allResults = results.map(r => r.status === "fulfilled" ? r.value : []).flat();

    const unique = new Map();
    allResults.forEach(t => {
        if (!unique.has(t.hash) || t.seeders > unique.get(t.hash).seeders) unique.set(t.hash, t);
    });

    const finalArr = Array.from(unique.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[HUB] 🏆 Gesamt nach Deduplizierung: ${finalArr.length} Torrents.`);
    
    if (finalArr.length > 0) searchCache.set(queryKey, { data: finalArr, expiresAt: Date.now() + CACHE_TTL_MS });
    return finalArr;
}

function cleanTorrentTitle(title) {
    let clean = title;
    clean = clean.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, "").replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, "");
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, "");
    return clean.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim() || title; 
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
