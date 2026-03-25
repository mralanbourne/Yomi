const { addonBuilder } = require("stremio-addon-sdk");
const { searchAdultAnime, getAnimeMeta, getTrendingAdultAnime, getTopAdultAnime, getJikanMeta } = require('./lib/anilist');
const { searchSukebeiForHentai, cleanTorrentTitle } = require('./lib/sukebei');
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require('./lib/debrid');

const manifest = {
    id: "org.community.yomi",
    version: "4.1.0",
    name: "Yomi",
    logo: "https://github.com/mralanbourne/Yomi/blob/main/static/yomi.png?raw=true", 
    description: "Ultimate Hentai Gateway. Bulletproof Episode Regex, Bracket Support & Proxy Subs.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "sukebei:"],
    catalogs: [
        { id: "sukebei_trending", type: "series", name: "Trending" },
        { id: "sukebei_top", type: "series", name: "Top Rated" },
        { id: "sukebei_search", type: "series", name: "Yomi Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "apiKey", type: "text", title: "API Key (RD or TB)", required: true }],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

function parseConfig(config) {
    if (!config) return {};
    if (typeof config === 'object') return config;
    try { return JSON.parse(Buffer.from(config, 'base64').toString()); } catch (e) {
        try { return JSON.parse(decodeURIComponent(config)); } catch (e2) { return {}; }
    }
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    if (match[2].toLowerCase().includes('g')) return val * 1073741824;
    if (match[2].toLowerCase().includes('m')) return val * 1048576;
    return val;
}

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

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ----------------------------------------------------------------------------------
// ULTRA-STRICT CLEANING ENGINE (Lässt Episoden-Klammern in Ruhe!)
// ----------------------------------------------------------------------------------
function cleanStringForMatching(str) {
    return str.replace(/\b(?:1080|720|480|2160)[pi]\b/gi, ' ')
              .replace(/\b(?:x|h)26[45]\b/gi, ' ')
              .replace(/\b(?:HEVC|AVC|FHD|HD|SD)\b/gi, ' ')
              .replace(/\[[A-Fa-f0-9]{8}\]/g, ' ') // Entfernt Anime Checksums wie [A1B2C3D4]
              .replace(/\.(mkv|mp4|avi|wmv|srt|ass|ssa|vtt|sub|idx)$/i, '')
              .trim();
}

function isEpisodeMatch(name, requestedEp) {
    const clean = cleanStringForMatching(name);
    const epNum = parseInt(requestedEp, 10);
    
    // 1. Batch Check (01-04, 1~4)
    const batchMatch = clean.match(/(?:^|[\[\(_\-\s])0*(\d+)\s*(?:-|~|to)\s*0*(\d+)(?:[\]\)_\-\s]|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10);
        const end = parseInt(batchMatch[2], 10);
        if (epNum >= start && epNum <= end) return true;
    }

    // 2. Standard S01E02 Format
    const sxxEyy = new RegExp(`[Ss]\\d+[Ee]0*${epNum}(?:v\\d)?\\b`, 'i');
    if (sxxEyy.test(clean)) return true;

    // 3. Strikter Check mit Umrandung (Findet [02], (02), - 02, Ep. 2)
    const epRegex = new RegExp(`(?:^|[\\s_\\[\\(\\-~])(?:[Ee][Pp](?:isode)?\\s*\\.?\\s*|[Oo][Vv][Aa]\\s*)?0*${epNum}(?:v\\d)?(?:[\\s_\\]\\)\\-\\.~]|$)`, 'i');
    if (epRegex.test(clean)) return true;

    // 4. Fail-Safe für Folge 1 (Movies)
    if (epNum === 1) {
        const hasOtherEp = /(?:^|[\s_\[\(\-~])(?:[Ee][Pp](?:isode)?\s*\.?\s*|[Oo][Vv][Aa]\s*)?0*([2-9]|[1-9]\d+)(?:v\d)?(?:[\s_\]\)\-\.~]|$)/i.test(clean);
        if (!hasOtherEp) return true;
    }

    return false;
}

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
    
    if (videoFiles.length === 1 && parseInt(requestedEp, 10) === 1) return videoFiles[0];
    return null;
}

function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all/i.test(title)) return true;
    return isEpisodeMatch(title, requestedEp);
}

// BEREINIGTE POSTER (Nur für das Bild werden alle Klammern gelöscht)
function generateDynamicPoster(title) {
    let clean = title.replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ');
    let safeTitle = clean.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s{2,}/g, ' ').substring(0, 30).trim().toUpperCase();
    
    let words = safeTitle.split(" ");
    let lines = [];
    let line = "";
    
    for (let word of words) {
        if ((line + word).length > 10) {
            if (line) lines.push(line.trim());
            line = word + " ";
        } else {
            line += word + " ";
        }
    }
    if (line) lines.push(line.trim());
    
    const text = encodeURIComponent(lines.join('\n'));
    return `https://dummyimage.com/600x900/1a1a1a/e91e63.png&text=${text}`;
}

builder.defineCatalogHandler(async ({ id, extra }) => {
    if (id === "sukebei_trending") return { metas: await getTrendingAdultAnime(), cacheMaxAge: 43200 };
    if (id === "sukebei_top") return { metas: await getTopAdultAnime(), cacheMaxAge: 43200 };
    if (id === "sukebei_search" && extra.search) {
        const [anilistMetas, sukebeiTorrents] = await Promise.all([searchAdultAnime(extra.search), searchSukebeiForHentai(extra.search)]);
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
                    name: cleanName.replace(/\[.*?\]/g, '').trim(), 
                    poster: generateDynamicPoster(cleanName) 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    let meta = null;
    let searchTitle = "";

    if (id.startsWith('anilist:')) {
        const parts = id.split(':');
        meta = await getAnimeMeta(parts[1]);
        searchTitle = meta ? meta.name : Buffer.from(parts[2], 'base64url').toString('utf8');
        if (!meta) meta = { id, type: 'series', name: searchTitle };
    } else if (id.startsWith('sukebei:')) {
        searchTitle = Buffer.from(id.split(':')[1], 'base64url').toString('utf8');
        
        let cleanQuery = searchTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        const malData = await getJikanMeta(cleanQuery);
        
        if (malData) {
            meta = { 
                id, type: 'series', name: searchTitle.replace(/\[.*?\]/g, '').trim(), 
                poster: malData.poster || generateDynamicPoster(searchTitle),
                background: malData.background, description: malData.description, episodes: malData.episodes
            };
        } else {
            meta = { id, type: 'series', name: searchTitle.replace(/\[.*?\]/g, '').trim(), poster: generateDynamicPoster(searchTitle) };
        }
    }

    meta.type = 'series';
    let epCount = meta.episodes || 1;

    if (epCount === 1 || !meta.episodes) {
        try {
            const torrents = await searchSukebeiForHentai(searchTitle);
            let maxDetected = 1;
            torrents.forEach(t => {
                let clean = cleanStringForMatching(t.title);
                const batchMatch = clean.match(/(?:^|[\[\(_\-\s])0*(\d+)\s*(?:-|~|to)\s*0*(\d+)(?:[\]\)_\-\s]|$)/i);
                if (batchMatch) {
                    const end = parseInt(batchMatch[2], 10);
                    if (end > maxDetected && end < 50) maxDetected = end;
                }
                const epMatch = clean.match(/(?:^|[\s_\[\(\-~])(?:[Ee][Pp](?:isode)?\s*\.?\s*|[Oo][Vv][Aa]\s*)?(0*[1-9]\d*)(?:v\d)?(?:[\s_\]\)\-\.~]|$)/i);
                if (epMatch) {
                    const num = parseInt(epMatch[1], 10);
                    if (num > maxDetected && num < 50) maxDetected = num;
                }
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

builder.defineStreamHandler(async ({ id, config }) => {
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

    return { streams: streams.sort((a,b) => (a.name.includes('⚡') ? -1 : 1) || (b._bytes - a._bytes)), cacheMaxAge: 5 };
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
