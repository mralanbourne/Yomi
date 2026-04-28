//===============
// AMATSU & YOMI PARSING ENGINE (BATCH-SIZE & CJK OPTIMIZED)
// The parsing engine heavily sanitizes complex naming conventions found in the Hentai scene,
// mapping Roman numerals, explicit episode indicators, and Japanese Kanji back to standardized integers.
//===============

//===============
// FILENAME SANITIZER
// Aggressively strips away resolution tags, release groups, codecs, and checksums from the string.
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

//===============
// TITLE NORMALIZER
// Translates full-width characters and Chinese/Japanese numerics into standard ASCII formatting.
//===============
function normalizeTitle(text) {
    if (!text) return "";
    let normalized = text.toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u3000]/g, " "); 
    const cjkMap = { "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10" };
    for (const [cjk, num] of Object.entries(cjkMap)) { normalized = normalized.replace(new RegExp(cjk, "g"), num); }
    return normalized.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ").replace(/\s{2,}/g, " ").trim();
}

//===============
// TITLE VERIFICATION
// Determines if a torrent title matches any of the allowed master search titles via fuzzy token matching.
//===============
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
        
        // Exact match via Regex
        if (regex.test(stripped)) return true;
        
        // Condensed match (no spaces)
        const cleanNoSpaces = cleanTitle.replace(/\s+/g, "");
        if (cleanNoSpaces.length >= 6 && strippedNoSpaces.includes(cleanNoSpaces)) return true;
        
        // Tokenized ratio matching
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

//===============
// EPISODE EXTRACTOR
// Identifies the exact episode number inside a filename string using explicit keywords or trailing digits.
// Resolves cases where roman numerals or english words are used instead of integers.
//===============
function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = sanitizeFilename(filename);
    const wordMap = { "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10 };
    
    clean = clean.replace(/\b(?:part|vol(?:ume)?|chapter|episode|ep|act|round|話|话|集|회|편)\.?\s*(one|two|three|four|five|six|seven|eight|nine|ten|i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/ig, (m, p1) => m.replace(p1, wordMap[p1.toLowerCase()]));
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:季|期|기)/ig, "");
    
    // Most common structured episode indicators
    const explicitRegex = /(?:ep(?:isode)?\.?\s*|\be\s*|ova\s*|oad\s*|special\s*|round\s*|act\s*|chapter\s*|part\s*|vol(?:ume)?\.?\s*|第\s*|#\s*|s(\d+)\s*e|season\s*(\d+)\s*ep(?:isode)?\s*)0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편|v\d+))?(?:\D|$)/i;
    const explicitMatch = clean.match(explicitRegex);
    
    if (explicitMatch) {
        const fileSeason = explicitMatch[1] || explicitMatch[2];
        if (fileSeason !== undefined && parseInt(fileSeason, 10) !== expectedSeason) return -1;
        return parseInt(explicitMatch[3], 10);
    }
    
    // Match dashed or bracketed numerics
    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:\D|$)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    const bracketMatch = clean.match(/\[0*(\d+)\]|\(0*(\d+)\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);
    
    // Ultimate fallback: Find isolated numbers at the very end of the string
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^e?0*(\d+)(?:v\d+)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

//===============
// BATCH RANGE IDENTIFIER
// Scans the filename for sequential range indicators like "01-12" or "01~05" to define bulk collections.
//===============
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
// BATCH VALIDATION & SIZE HEURISTICS
// Employs bytesize analysis to prevent false positive batch detections. 
// A "Batch" under 1.5 GB is highly likely to be a single episode, disregarding its title.
//===============
function isSeasonBatch(filename, expectedSeason, sizeBytes = 0) {
    const clean = filename.toLowerCase();
    const hasBatchWord = /\b(batch|complete|collection|boxset|box-set|box\b|bd-box|dvd-box|all episodes|all eps|disc|pack)\b|全集|완결|전편|全話/i.test(clean);
    const range = getBatchRange(filename);
    
    if (hasBatchWord || range) {
        if (sizeBytes > 0 && sizeBytes < 1500 * 1024 * 1024) return false; 
        return true;
    }
    return extractEpisodeNumber(filename, expectedSeason) === null;
}

//===============
// EPISODE MATCHER
// Validates whether the requested Stremio episode matches the parsed file metadata.
//===============
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

//===============
// FILE SELECTOR
// Digs through Debrid file lists inside a torrent container, skipping over junk/trailers,
// and selecting the actual video file that matches the requested episode.
//===============
function selectBestVideoFile(files, requestedEp, expectedSeason = 1, isMovie = false) {
    if (!files || files.length === 0) return null;
    let videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;
    const epNum = parseInt(requestedEp, 10);

    // Apply strict file-size bounds to prevent trailers (too small) or raw packs (too large) from being selected
    if (!isMovie) {
        videoFiles = videoFiles.filter(f => {
            const s = f.size || f.bytes || 0;
            return s === 0 || (s >= 30 * 1024 * 1024 && s <= 5500 * 1024 * 1024);
        });
    }

    let matches = videoFiles.filter(f => {
        const fname = f.name || f.path || "";
        return extractEpisodeNumber(fname, expectedSeason) === epNum || 
               (getBatchRange(fname) && epNum >= getBatchRange(fname).start && epNum <= getBatchRange(fname).end);
    });

    if (matches.length === 0 && videoFiles.length === 1) {
        const singleFile = videoFiles[0];
        const s = singleFile.size || singleFile.bytes || 0;
        if (s > 2000 * 1024 * 1024) return singleFile;
    }

    const target = matches.length > 0 ? matches : videoFiles;
    
    // Prefer MKV containers over MP4, then sort by highest filesize (highest bitrate)
    return target.sort((a, b) => {
        const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        if (aMkv !== bMkv) return bMkv - aMkv;
        return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
    })[0];
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
