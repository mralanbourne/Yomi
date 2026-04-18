//===============
// AMATSU & YOMI PARSING ENGINE (UNIFIED & BALANCED v2)
// Optimierte Balance: Verhindert False-Positives durch LCS-Wortprüfung,
// erlaubt aber Uploader-Abkürzungen und Zusatz-Tags flexibel.
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
    return text.toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u3000]/g, " ")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function verifyTitleMatch(filename, searchTitles) {
    if (!searchTitles || searchTitles.length === 0) return true;
    
    const cleanFilename = sanitizeFilename(filename);
    const stripped = normalizeTitle(cleanFilename);
    const strippedNoSpaces = stripped.replace(/\s+/g, "");
    const filenameWords = stripped.split(/\s+/).filter(w => w.length > 1); // Ignoriere Einzelbuchstaben

    for (const title of searchTitles) {
        if (!title) continue;
        const cleanTitle = normalizeTitle(title);
        if (!cleanTitle) continue;

        // 1. Exakter Boundary Match (Bester Schutz)
        const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?:^|\\s)${escapedTitle}(?:\\s|$)`, "i");
        if (regex.test(stripped)) return true;

        // 2. No-Space Match (Fuer "NatsutoHako")
        const cleanNoSpaces = cleanTitle.replace(/\s+/g, "");
        if (cleanNoSpaces.length >= 8 && strippedNoSpaces.includes(cleanNoSpaces)) return true;

        // 3. Smart Sequence Match (Verhindert False Positives bei "Android wa...")
        // Wir prüfen, ob die Wörter des Torrents im Suchbegriff vorkommen oder umgekehrt
        const queryWords = cleanTitle.split(/\s+/).filter(w => w.length > 1);
        
        if (queryWords.length >= 2) {
            let matches = 0;
            queryWords.forEach(qw => {
                if (filenameWords.includes(qw)) matches++;
            });

            // Wenn mindestens 60% der Wörter matchen UND die ersten zwei Wörter (Anfang) passen
            const matchRatio = matches / queryWords.length;
            const startMatches = filenameWords[0] === queryWords[0] || stripped.startsWith(queryWords.slice(0, 2).join(" "));

            if (matchRatio >= 0.6 && startMatches) {
                return true;
            }
            
            // Sonderfall: Torrent ist kürzer als Query (Uploader Abkürzung)
            // Wenn der Torrent nur aus Query-Wörtern besteht (z.B. "Android wa" für die volle Query)
            if (filenameWords.length >= 2 && filenameWords.length < queryWords.length) {
                const allWordsInQuery = filenameWords.every(fw => queryWords.includes(fw));
                if (allWordsInQuery && startMatches) return true;
            }
        }
    }
    return false;
}

function isWrongSeason(filename, expectedSeason) {
    const clean = filename.toLowerCase();
    const seasonRegex = /(?:s|season|part|cour)\s*0*(\d+)\b|第\s*0*(\d+)\s*(?:季|期|기)|\b(\d+)(?:st|nd|rd|th)\s+(?:season|part|cour)\b/ig;
    let match;
    let foundExplicitSeason = false;
    let foundRight = false;
    while ((match = seasonRegex.exec(clean)) !== null) {
        const s = parseInt(match[1] || match[2] || match[3], 10);
        foundExplicitSeason = true;
        if (s === expectedSeason) foundRight = true;
    }
    return foundExplicitSeason ? !foundRight : false;
}

function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = sanitizeFilename(filename);
    const wordMap = { "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10 };
    clean = clean.replace(/\b(?:part|vol(?:ume)?|chapter|episode|ep|act|round)\.?\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/ig, (m, p1) => m.replace(p1, wordMap[p1.toLowerCase()]));
    const romanMap = { "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10 };
    clean = clean.replace(/\b(?:part|vol(?:ume)?|chapter|episode|ep|act|round)\.?\s+(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/ig, (m, p1) => m.replace(p1, romanMap[p1.toLowerCase()]));
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
        const numMatch = tokens[i].match(/^e?0*(\d+)(?:v\d+)?$/i);
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

function extractLooseEpisode(filename) {
    let clean = sanitizeFilename(filename);
    const romanMap = { "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10 };
    clean = clean.replace(/\b(?:part|vol(?:ume)?|chapter|episode|ep)\.?\s+(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/ig, (m, p1) => m.replace(p1, romanMap[p1.toLowerCase()]));
    const regex = /(?:^|[\s\[\]\(\)\{\}_\-\+~,#])0*(\d+)(?:v\d+)?(?:[\s\[\]\(\)\{\}_\-\+~,#\.]|$)/ig;
    let match;
    while ((match = regex.exec(clean)) !== null) {
        const num = parseInt(match[1], 10);
        if (num < 3000 && num > 0) return num;
    }
    return null;
}

function getBatchRange(filename) {
    let clean = sanitizeFilename(filename);
    const batchMatch = clean.match(/(?:^|\D)(?:第\s*|vol(?:ume)?\.?\s*|e?p?\.?\s*)?0*(\d+)\s*(?:-|~|to|a|&|\+)\s*(?:e?p?\.?\s*)?0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편))?(?:\D|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10), end = parseInt(batchMatch[2], 10);
        if (end > start && end - start < 3000) return { start, end };
    }
    return null;
}

function isSeasonBatch(filename, expectedSeason) {
    if (isWrongSeason(filename, expectedSeason)) return false;
    const clean = filename.replace(/\..{3,4}$/, "");
    const hasBatchWord = /\b(batch|complete|collection|boxset|box\b|bd-box|dvd-box|all episodes|all eps)\b|全集|완결|전편/i.test(clean);
    if (hasBatchWord || getBatchRange(filename)) return true;
    return extractEpisodeNumber(filename, expectedSeason) === null && extractLooseEpisode(filename) === null;
}

function isEpisodeMatch(name, requestedEp, expectedSeason = 1) {
    if (isWrongSeason(name, expectedSeason)) return false;
    const filename = name.split("/").pop();
    const epNum = parseInt(requestedEp, 10);
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;
    const matchedEp = extractEpisodeNumber(filename, expectedSeason) === epNum || extractLooseEpisode(filename) === epNum;
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
            return s === 0 || (s >= 30 * 1024 * 1024 && s <= 4.5 * 1024 * 1024 * 1024);
        });
    }
    if (videoFiles.length === 0) return null;
    let matches = videoFiles.filter(f => extractEpisodeNumber(f.name || f.path || "", expectedSeason) === epNum);
    if (matches.length === 0) matches = videoFiles.filter(f => {
        const b = getBatchRange(f.name || f.path || "");
        return b && epNum >= b.start && epNum <= b.end;
    });
    if (matches.length === 0) matches = videoFiles.filter(f => extractLooseEpisode(f.name || f.path || "") === epNum);
    const target = matches.length > 0 ? matches : videoFiles;
    return target.sort((a, b) => {
        const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
        if (aMkv !== bMkv) return bMkv - aMkv;
        return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
    })[0];
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
