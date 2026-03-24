const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// Cleans dirty torrent names to group them correctly in the catalog
function cleanTorrentTitle(title) {
    let clean = title;
    // Remove tags like [Group] and (Resolution)
    clean = clean.replace(/\[.*?\]/g, '');
    clean = clean.replace(/\(.*?\)/g, '');
    // Remove file extensions
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, '');
    // Remove episode markers
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, '');
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, '');
    // Remove standard keywords
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, '');
    // Clean up underscores and extra spaces
    clean = clean.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
    
    // Return original title if the regex stripped everything
    return clean || title; 
}

async function searchSukebeiForHentai(romajiTitle) {
    const encodedQuery = encodeURIComponent(romajiTitle);
    const rssUrl = `https://sukebei.nyaa.si/?page=rss&c=1_1&f=0&q=${encodedQuery}`;

    try {
        const response = await axios.get(rssUrl, {
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" }
        });

        if (typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE html>')) {
            console.error("[Sukebei] Cloudflare Blocked the request.");
            return [];
        }

        const parser = new XMLParser({ ignoreAttributes: true });
        const jsonObj = parser.parse(response.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

        return items.map(item => {
            // FIX: Sukebei Tracker Quirk - Brand new torrents return "NOT_INDEX"
            let rawSize = item["nyaa:size"] || "Unknown";
            if (rawSize.includes("NOT_INDEX") || rawSize === "Unknown") {
                rawSize = "? GB"; // Fallback for unindexed torrents
            }

            // FIX: Prevent NaN bugs if seeders are "NOT_INDEX"
            let seeders = parseInt(item["nyaa:seeders"], 10);
            if (isNaN(seeders)) {
                seeders = 0; 
            }

            return {
                title: item.title || "Unknown Release",
                hash: item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null,
                seeders: seeders,
                size: rawSize
            };
        }).filter(t => t.hash !== null).sort((a, b) => b.seeders - a.seeders);

    } catch (error) {
        console.error(`[Sukebei] Error fetching "${romajiTitle}":`, error.message);
        return [];
    }
}

module.exports = { searchSukebeiForHentai, cleanTorrentTitle };