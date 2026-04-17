//===============
// YOMI SUKEBEI SCRAPER - SMART QUEUE EDITION
//===============
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

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

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

// Die mathematische Queue-Logik gegen Cloudflare-Bans
let lastRequestTime = 0;
const DELAY_MS = 1200; 

async function fetchWithQueue(url) {
    const now = Date.now();
    const timeToWait = Math.max(0, lastRequestTime + DELAY_MS - now);
    lastRequestTime = now + timeToWait; 
    
    if (timeToWait > 0) {
        await new Promise(res => setTimeout(res, timeToWait));
    }
    
    return axios.get(url, {
        timeout: 10000,
        headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml, */*"
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

async function searchSukebeiForHentai(queryOriginal) {
    if (!queryOriginal || queryOriginal.trim().length < 3) return [];

    const queryKey = queryOriginal.trim().toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
        searchCache.delete(queryKey);
    }

    console.log(`\n[SUKEBEI] 🔍 Queue Search: "${queryKey}"`);

    const queries = [queryOriginal.trim()];
    const delimiters = /[:!\-~]/;
    if (delimiters.test(queryOriginal)) {
        const shortTitle = queryOriginal.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) queries.push(shortTitle);
    }

    const uniqueResults = new Map();

    for (const query of queries) {
        let attempts = 0;
        let success = false;

        while (attempts < MIRRORS.length && !success) {
            const domain = MIRRORS[currentMirrorIndex];
            const rssUrl = `${domain}/?page=rss&f=0&c=0_0&q=${encodeURIComponent(query)}`;

            try {
                const start = Date.now();
                const response = await fetchWithQueue(rssUrl);
                const duration = Date.now() - start;

                if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                    throw new Error("Cloudflare/HTML-Block received");
                }

                console.log(`[MIRROR INFO] ✅ ${domain} -> SUCCESS [${duration}ms]`);
                const parser = new XMLParser({ ignoreAttributes: true });
                const jsonObj = parser.parse(response.data);
                const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

                items.forEach(item => {
                    const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
                    if (!hash || uniqueResults.has(hash)) return;

                    uniqueResults.set(hash, {
                        title: item.title || "Unknown Release",
                        hash: hash,
                        seeders: parseInt(item["nyaa:seeders"], 10) || 0,
                        size: item["nyaa:size"] || "Unknown"
                    });
                });

                success = true;
            } catch (error) {
                console.log(`[MIRROR INFO] ❌ ${domain} -> FAIL`);
                getNextMirror();
                attempts++;
            }
        }
    }

    const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
    searchCache.set(queryKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
    
    return results;
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };
