//===============
// AMATSU & YOMI PARSING ENGINE (BATCH-SIZE & CJK OPTIMIZED)
//===============

function sanitizeFilename(filename) {
    return filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
        .replace(/^\[.*?\]/g, "")
        .replace(/\b(?:\d{3,4}x\d{3,4})\b/gi, "")
        .replace(/\b(?:2160|1080|810|720|576|540|480|360)[pix]*\b/gi, "")
        .replace(/\b(?:x|h)26[45]\b/gi, "")
        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10-?bits?|8-?bits?|12-?bits?|Hi10P|Hi444P)\b/gi, "")
        .replace(/\b(?:BD|BDRip|Blu-?ray|WEB-?DL|WEB-?Rip|DVD|DVDRip|TVRip|HDTV|CAM)\b/gi, "")
        .replace(/\b(?:FLAC|AAC|AC3|DTS|DTS-HD|TrueHD|Vorbis|Opus|MP3|PCM)\b/gi, "")
        .replace(/\b(?:Uncensored|Censored|Decensored|Uncen|Dual-?Audio|Multi-?Subs|RAW|Hentai)\b/gi, "")
        .replace(/\b(?:5\.1|2\.0|7\.1|2\.1)\b/g, "")
        .replace(/\[[a-fA-F0-9]{8}\]/g, "")
        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ")
        .replace(/\b(?:v\d)\b/gi, "")
        .replace(/\b(?:19|20)\d{2}\b/g, "");
}

function normalizeTitle(text) {
    if (!text) return "";
    let normalized = text.toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u3000]/g, " "); 
    const cjkMap = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
    for (const [cjk, num] of Object.entries(cjkMap)) { normalized = normalized.replace(new RegExp(cjk, 'g'), num); }
    return normalized.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ").replace(/\s{2,}/g, " ").trim();
}

function verifyTitleMatch(filename, searchTitles) {
    if (!searchTitles || searchTitles.length === 0) return true;
    const cleanFilename = sanitizeFilename(filename);
    const stripped = normalizeTitle(cleanFilename);
    const strippedNoSpaces = stripped.replace(/\s+/g, "");
    const filenameWords = stripped.split(/\s+/).filter(w => w.length > 1);
    for (const title of searchTitles) {
        if (!title) continue;
        const cleanTitle = normalizeTitle(title);
        if (!cleanTitle) continue;
        const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?:^|\\s)${escapedTitle}(?:\\s|$)`, "i");
        if (regex.test(stripped)) return true;
        const cleanNoSpaces = cleanTitle.replace(/\s+/g, "");
        if (cleanNoSpaces.length >= 6 && strippedNoSpaces.includes(cleanNoSpaces)) return true;
        const queryWords = cleanTitle.split(/\s+/).filter(w => w.length > 1);
        if (queryWords.length >= 2) {
            let matches = 0;
            queryWords.forEach(qw => { if (filenameWords.includes(qw)) matches++; });
            const matchRatio = matches / queryWords.length;
            const startMatches = filenameWords[0] === queryWords[0] || stripped.startsWith(queryWords.slice(0, 2).join(" "));
            if (matchRatio >= 0.6 && startMatches) return true;
            if (filenameWords.length >= 2 && filenameWords.length < queryWords.length) {
                if (filenameWords.every(fw => queryWords.includes(fw)) && startMatches) return true;
            }
        }
    }
    return false;
}

function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = sanitizeFilename(filename);
    const wordMap = { "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10 };
    clean = clean.replace(/\b(?:part|vol(?:ume)?|chapter|episode|ep|act|round|話|话|集|회|편)\.?\s*(one|two|three|four|five|six|seven|eight|nine|ten|i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/ig, (m, p1) => m.replace(p1, wordMap[p1.toLowerCase()]));
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:季|期|기)/ig, "");
    const explicitRegex = /(?:ep(?:isode)?\.?\s*|\be\s*|ova\s*|oad\s*|special\s*|round\s*|act\s*|chapter\s*|part\s*|vol(?:ume)?\.?\s*|第\s*|#\s*|s(\d+)\s*e|season\s*(\d+)\s*ep(?:isode)?\s*)0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편|v\d+))?(?:\D|$)/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) {
        const fileSeason = explicitMatch[1] || explicitMatch[2];
        if (fileSeason !== undefined && parseInt(fileSeason, 10) !== expectedSeason) return -1;
        return parseInt(explicitMatch[3], 10);
    }
    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:\D|$)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    const bracketMatch = clean.match(/\[0*(\d+)\]|\(0*(\d+)\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^e?0*(\d+)(?:v\d+)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

function getBatchRange(filename) {
    let clean = sanitizeFilename(filename);
    const batchMatch = clean.match(/(?:^|\D)(?:第\s*|vol(?:ume)?\.?\s*|e?p?\.?\s*)?0*(\d+)\s*(?:\-|~|to|a|&|\+|\.\.)\s*(?:e?p?\.?\s*)?0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편|全話|完))?(?:\D|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10), end = parseInt(batchMatch[2], 10);
        if (end > start && end - start < 3000) return { start, end };
    }
    const totalMatch = clean.match(/全\s*(\d+)\s*(?:話|话|集)/i);
    if (totalMatch) return { start: 1, end: parseInt(totalMatch[1], 10) };
    return null;
}

//===============
// VERBESSERTE BATCH-ERKENNUNG MIT GRÖSSEN-HEURISTIK
//===============
function isSeasonBatch(filename, expectedSeason, sizeBytes = 0) {
    const clean = filename.toLowerCase();
    const hasBatchWord = /\b(batch|complete|collection|boxset|box-set|box\b|bd-box|dvd-box|all episodes|all eps|disc|pack)\b|全集|완결|전편|全話/i.test(clean);
    const range = getBatchRange(filename);
    
    // Wenn es ein Range (01-12) oder Batch-Wort ist
    if (hasBatchWord || range) {
        // Heuristik: Ein Batch unter 1.5 GB ist bei Anime/Hentai fast immer ein Fake oder nur eine Episode
        if (sizeBytes > 0 && sizeBytes < 1500 * 1024 * 1024) return false; 
        return true;
    }
    
    // Falls keine Episode gefunden wurde aber Titel passt -> Wahrscheinlich Batch
    return extractEpisodeNumber(filename, expectedSeason) === null;
}

function isEpisodeMatch(name, requestedEp, expectedSeason = 1) {
    const filename = name.split("/").pop();
    const epNum = parseInt(requestedEp, 10);
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;
    const matchedEp = extractEpisodeNumber(filename, expectedSeason) === epNum;
    if (matchedEp && expectedSeason > 1 && !batch) {
        const hasSeasonTag = /(?:s|season|part|cour)\s*0*\d+|第\s*0*\d+\s*(?:季|期|기)|\b\d+(?:st|nd|rd|th)\s+(?:season|part|cour)\b/i.test(filename);
        if (!hasSeasonTag && !new RegExp(`\\b${expectedSeason}\\b`).test(sanitizeFilename(filename))) return false;
    }
    return matchedEp;
}

function selectBestVideoFile(files, requestedEp, expectedSeason = 1, isMovie = false) {
    if (!files || files.length === 0) return null;
    let videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;
    const epNum = parseInt(requestedEp, 10);

    if (!isMovie) {
        videoFiles = videoFiles.filter(f => {
            const s = f.size || f.bytes || 0;
            // Eine einzelne Episode sollte in der Regel nicht groesser als 5GB sein (ausser 4K Remux)
            // Und nicht kleiner als 30MB (Trailer/Junk)
            return s === 0 || (s >= 30 * 1024 * 1024 && s <= 5500 * 1024 * 1024);
        });
    }

    let matches = videoFiles.filter(f => {
        const fname = f.name || f.path || "";
        // In einem Batch-Container suchen wir EXAKT nach der Episode
        return extractEpisodeNumber(fname, expectedSeason) === epNum || 
               (getBatchRange(fname) && epNum >= getBatchRange(fname).start && epNum <= getBatchRange(fname).end);
    });

    // Falls in einem großen Torrent keine Episoden-Dateien gefunden werden (z.B. Torrent ist nur EINE Datei für alles)
    if (matches.length === 0 && videoFiles.length === 1) {
        const singleFile = videoFiles[0];
        const s = singleFile.size || singleFile.bytes || 0;
        // Wenn die Datei riesig ist (>2GB), lassen wir sie als Batch-Fallback durch
        if (s > 2000 * 1024 * 1024) return singleFile;
    }

    const target = matches.length > 0 ? matches : videoFiles;
    return target.sort((a, b) => {
        const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        if (aMkv !== bMkv) return bMkv - aMkv;
        return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
    })[0];
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
