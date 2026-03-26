/**
 * YOMI STREMIO ADDON - CORE LOGIC
 * * This is the main entry point for the Stremio Addon logic.
 * It defines how the addon interacts with Stremio via the SDK.
 * * Key Responsibilities:
 * 1. Metadata Handling (AniList/MAL integration)
 * 2. Catalog Management (Trending, Top Rated, Search)
 * 3. Stream Resolution (Searching Sukebei and verifying Debrid availability)
 * 4. Episode Extraction (Parsing messy torrent titles)
 */

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getJikanMeta } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

// ============================================================================
// ADDON MANIFEST
// Defines the addon's identity and capabilities for the Stremio client.
// ============================================================================
const manifest = {
    id: "org.community.yomi",
    version: "5.1.5",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "The ultimate Debrid-powered Sukebei gateway. Streams raw, uncompressed Hentai & NSFW Anime directly via Real-Debrid or Torbox. Smart-parsing tames chaotic torrent names for a clean catalog. Pure quality, zero buffering. Info: github.com/mralanbourne/Yomi",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [
        { id: "sukebei_trending", type: "series", name: "Yomi Trending" },
        { id: "sukebei_top", type: "series", name: "Yomi Top Rated" },
        { id: "sukebei_search", type: "series", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "apiKey", type: "text", title: "API Key (RD or TB)", required: true }],
    behaviorHints: { configurable: true, configurationRequired: true },
};

const builder = new addonBuilder(manifest);

// ============================================================================
// UTILITY FUNCTIONS: CONFIGURATION & PARSING
// ============================================================================

/**
 * Safely parses the user's Debrid configuration from the URL.
 * Supports both Base64 and standard URI encoding.
 */
function parseConfig(config) {
    if (!config) return {};
    if (typeof config === 'object') return config;
    try { return JSON.parse(Buffer.from(config, 'base64').toString()); } catch (e) {
        try { return JSON.parse(decodeURIComponent(config)); } catch (e2) { return {}; }
    }
}

/**
 * Converts torrent size strings (e.g., "1.5 GiB") into raw bytes for sorting.
 */
function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    if (match[2].toLowerCase().includes('g')) return val * 1073741824;
    if (match[2].toLowerCase().includes('m')) return val * 1048576;
    return val;
}

/**
 * Scans titles for quality (1080p, 4K) and language tags (Sub, Uncen).
 * Used for visual labels in the Stremio stream list.
 */
function extractTags(title) {
    let res = "SD", lang = "Raw";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    
    if (/(eng|english)/i.test(title)) lang = "Eng Sub";
    else if (/(multi|dual)/i.test(title)) lang = "Multi";
    else if (/(sub)/i.test(title)) lang = "Subbed";
    
    if (/(uncensored|decensored)/i.test(title)) lang += " | Uncen";
    return { res, lang };
}

/**
 * Removes brackets and excess space from titles to optimize tracker search results.
 */
function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ============================================================================
// ADVANCED EPISODE EXTRACTION ENGINE
// ============================================================================

/**
 * Detects if a filename represents a "Batch" (e.g., "01-12") or a single episode.
 */
function getBatchRange(filename) {
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|srt|ass|ssa|vtt|sub|idx)$/i, '')
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, '');
    const batchMatch = clean.match(/\b0*(\d+)\s*(?:-|~|to)\s*0*(\d+)\b/i);
    if (batchMatch) return { start: parseInt(batchMatch[1], 10), end: parseInt(batchMatch[2], 10) };
    return null;
}

/**
 * Core Logic: Extracts an episode number from a messy torrent filename.
 * Uses a multi-stage regex approach: Explicit tags -> Dash separation -> Positional fallback.
 */
function extractEpisodeNumber(filename) {
    // Stage 1: Strip common technical noise
    let clean = filename.replace(/\.(mkv|mp4|avi|wmv|srt|ass|ssa|vtt|sub|idx)$/i, '')
                        .replace(/\b(?:1080|720|480|2160)[pi]\b/gi, '')
                        .replace(/\b(?:x|h)26[45]\b/gi, '')
                        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10bit|8bit|10-bit|8-bit)\b/gi, '')
                        .replace(/\[[a-fA-F0-9]{8}\]/g, '') 
                        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, ' ');

    // Stage 2: Explicit Markers (ep, episode, ova, s01e01)
    const explicitRegex = /(?:ep(?:isode)?\.?\s*|ova\s*|s\d+e)0*(\d+)(?:v\d)?\b/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) return parseInt(explicitMatch[1], 10);

    // Stage 3: Isolation Checks (e.g. " - 01 ")
    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:v\d)?(?:$|\s)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    
    const bracketMatch = clean.match(/\[0*(\d+)(?:v\d)?\]|\(0*(\d+)(?:v\d)?\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);

    // Stage 4: Positional Fallback (Takes the last isolated number)
    clean = clean.replace(/[\[\]\(\)\{\}_\-\+~,]/g, ' ').trim();
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^0*(\d+)(?:v\d)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

/**
 * Checks if a filename matches the requested episode, accounting for Batches.
 */
function isEpisodeMatch(name, requestedEp) {
    const epNum = parseInt(requestedEp, 10);
    const batch = getBatchRange(name);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;
    const extractedEp = extractEpisodeNumber(name);
    if (extractedEp !== null) return extractedEp === epNum;
    if (epNum === 1 && extractedEp === null) {
        return !/trailer|promo|menu|teaser/i.test(name);
    }
    return false;
}

/**
 * Selects the best video file from a torrent's file list based on quality and matching.
 */
function findEpisodeInFiles(files, requestedEp) {
    if (!files || files.length === 0) return null;
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv)$/i.test(f.name));
    const matches = videoFiles.filter(f => isEpisodeMatch(f.name, requestedEp));
    
    if (matches.length > 0) {
        return matches.sort((a, b) => {
            const aMkv = a.name.toLowerCase().endsWith('.mkv') ? 1 : 0;
            const bMkv = b.name.toLowerCase().endsWith('.mkv') ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || 0) - (a.size || 0);
        })[0];
    }
    return (videoFiles.length === 1 && parseInt(requestedEp, 10) === 1) ? videoFiles[0] : null;
}

function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all\s+episodes/i.test(title)) return true;
    return isEpisodeMatch(title, requestedEp);
}

/**
 * Generates an image-based placeholder poster for series not found in metadata APIs.
 */
function generateDynamicPoster(title) {
    let clean = title.replace(/^\[.*?\]\s*/g, '').replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ');
    let safeTitle = clean.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s{2,}/g, ' ').substring(0, 30).trim().toUpperCase();
    let words = safeTitle.split(" ");
    let lines = [];
    let line = "";
    for (let word of words) {
        if ((line + word).length > 10) {
            if (line) lines.push(line.trim());
            line = word + " ";
        } else { line += word + " "; }
    }
    if (line) lines.push(line.trim());
    return `https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=${encodeURIComponent(lines.join('\n'))}`;
}

// ============================================================================
// STREMIO HANDLERS
// ============================================================================

/**
 * CATALOG HANDLER
 * Provides lists of Anime to the Stremio UI (Trending, Top, Search).
 */
builder.defineCatalogHandler(async ({ id, extra }) => {
    if (id === "sukebei_trending") return { metas: await getTrendingAdultAnime(), cacheMaxAge: 43200 };
    if (id === "sukebei_top") return { metas: await getTopAdultAnime(), cacheMaxAge: 43200 };
    
    if (id === "sukebei_search" && extra.search) {
        const [anilistMetas, sukebeiTorrents] = await Promise.all([
            searchAdultAnime(extra.search), 
            searchSukebeiForHentai(extra.search)
        ]);
        const finalMetas = [...anilistMetas];
        const rawGroups = {};
        
        sukebeiTorrents.forEach(t => {
            const cleanName = cleanTorrentTitle(t.title);
            if (cleanName.length > 2 && !rawGroups[cleanName]) rawGroups[cleanName] = t;
        });
        
        Object.keys(rawGroups).forEach(cleanName => {
            if (!anilistMetas.some(m => m.name.toLowerCase().includes(cleanName.toLowerCase()))) {
                finalMetas.push({ 
                    id: `sukebei:${Buffer.from(cleanName).toString('base64url')}`, 
                    type: 'series', 
                    name: cleanName.replace(/^\[.*?\]\s*/g, '').trim(), 
                    poster: generateDynamicPoster(cleanName) 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

/**
 * META HANDLER
 * Fetches detailed info (poster, description, video list) for a specific series.
 */
builder.defineMetaHandler(async ({ id }) => {
    // SECURITY GUARD: Ignore external IDs (IMDB, etc.) that Stremio sends in the background.
    if (!id.startsWith('anilist:') && !id.startsWith('sukebei:')) {
        return Promise.resolve({ meta: null });
    }

    let meta = null;
    let searchTitle = "";

    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        meta = await getAnimeMeta(parts[1]);
        searchTitle = meta ? meta.name : Buffer.from(parts[2], 'base64url').toString('utf8');
        if (!meta) meta = { id, type: 'series', name: searchTitle, poster: generateDynamicPoster(searchTitle) };
    } else if (id.startsWith('sukebei:')) {
        searchTitle = Buffer.from(id.split(':')[1], 'base64url').toString('utf8');
        let cleanQuery = searchTitle.replace(/^\[.*?\]\s*/g, '').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        const malData = await getJikanMeta(cleanQuery);
        if (malData) {
            meta = { 
                id, type: 'series', name: searchTitle.replace(/^\[.*?\]\s*/g, '').trim(), 
                poster: malData.poster || generateDynamicPoster(searchTitle),
                background: malData.background, description: malData.description, episodes: malData.episodes
            };
        } else {
            meta = { id, type: 'series', name: searchTitle.replace(/^\[.*?\]\s*/g, '').trim(), poster: generateDynamicPoster(searchTitle) };
        }
    }

    // Dynamic Episode Detection: Scans Sukebei to find the highest episode number if API meta is insufficient.
    meta.type = 'series';
    let epCount = meta.episodes || 1;
    if (epCount === 1 || !meta.episodes) {
        try {
            const torrents = await searchSukebeiForHentai(searchTitle);
            let maxDetected = 1;
            torrents.forEach(t => {
                const batch = getBatchRange(t.title);
                if (batch && batch.end > maxDetected && batch.end < 50) maxDetected = batch.end;
                const ext = extractEpisodeNumber(t.title);
                if (ext && ext > maxDetected && ext < 50) maxDetected = ext;
            });
            if (maxDetected > epCount) epCount = maxDetected;
        } catch(e) {}
    }

    const videos = [];
    const episodeThumbnail = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/e91e63.png&text=YOMI+EPISODE";
    for (let i = 1; i <= epCount; i++) {
        videos.push({ id: `${id}:1:${i}`, title: `Episode ${i}`, season: 1, episode: i, released: new Date().toISOString(), thumbnail: episodeThumbnail });
    }
    meta.videos = videos;
    return { meta, cacheMaxAge: 604800 };
});

/**
 * STREAM HANDLER
 * The core of the addon: Finds playable links for a specific episode.
 */
builder.defineStreamHandler(async ({ id, config }) => {
    if (!id.startsWith('anilist:') && !id.startsWith('sukebei:')) return Promise.resolve({ streams: [] });

    const userConfig = parseConfig(config);
    let searchTitle = "", requestedEp = 1;
    
    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[2], 'base64url').toString('utf8'));
        if (parts.length >= 5) requestedEp = parseInt(parts[4], 10);
    } else if (id.startsWith('sukebei:')) {
        const parts = id.split(':');
        searchTitle = sanitizeSearchQuery(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (parts.length >= 4) requestedEp = parseInt(parts[3], 10);
    }

    let torrents = await searchSukebeiForHentai(searchTitle);
    if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

    const hashes = torrents.map(t => t.hash);
    const [rdC, tbC, rdA, tbA] = await Promise.all([
        userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
        userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {},
        userConfig.rdKey ? getActiveRD(userConfig.rdKey) : {},
        userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : {}
    ]);

    const streams = [];
    torrents.forEach(t => {
        const hashLow = t.hash.toLowerCase();
        const files = rdC[hashLow] || tbC[hashLow];
        let displayTitle = `🌐 Sukebei Network\n💾 ${t.size} | 👤 ${t.seeders}`;
        
        if (files) {
            const matchedFile = findEpisodeInFiles(files, requestedEp);
            if (!matchedFile) return; 
            displayTitle += `\n🎯 File: ${matchedFile.name}`;
        } else {
            if (!isTitleMatchingEpisode(t.title, requestedEp)) return; 
            displayTitle += `\n📄 ${t.title}`;
        }

        const { res, lang } = extractTags(t.title);
        const bytes = parseFloat(t.size) * 1024 * 1024 * 1024;
        
        // Helper: Builds subtitle objects for Debrid cloud files
        const buildSubs = (fileList, provider, apiKey) => {
            if (!fileList) return [];
            return fileList
                .filter(f => /\.(ass|srt|ssa|vtt|sub|idx)$/i.test(f.name))
                .map(f => {
                    let subLang = 'English';
                    if (/ger|deu|deutsch/i.test(f.name)) subLang = 'German';
                    else if (/spa|esp/i.test(f.name)) subLang = 'Spanish';
                    return { id: f.id, url: `${process.env.BASE_URL}/sub/${provider}/${apiKey}/${t.hash}/${f.id}`, lang: subLang };
                });
        };

        if (userConfig.rdKey) {
            const fRD = rdC[hashLow];
            const prog = rdA[hashLow];
            const name = (fRD || prog === 100) ? `YOMI [⚡ RD]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% RD]\n🎥 ${res}` : `YOMI [☁️ RD DL]\n🎥 ${res}`);
            streams.push({ name, title: displayTitle, url: `${process.env.BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/${requestedEp}`, subtitles: buildSubs(fRD, 'realdebrid', userConfig.rdKey), behaviorHints: { notWebReady: true, bingeGroup: `rd_${t.hash}` }, _bytes: bytes });
        }

        if (userConfig.tbKey) {
            const fTB = tbC[hashLow];
            const prog = tbA[hashLow];
            const name = (fTB || prog === 100) ? `YOMI [⚡ TB]\n🎥 ${res}` : (prog !== undefined ? `YOMI [⏳ ${prog}% TB]\n🎥 ${res}` : `YOMI [☁️ TB DL]\n🎥 ${res}`);
            streams.push({ name, title: displayTitle, url: `${process.env.BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/${requestedEp}`, subtitles: buildSubs(fTB, 'torbox', userConfig.tbKey), behaviorHints: { notWebReady: true, bingeGroup: `tb_${t.hash}` }, _bytes: bytes });
        }
    });

    // Sort streams: Cached (lightning bolt) first, then by size (highest quality)
    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
