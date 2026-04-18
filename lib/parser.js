//===============
// AMATSU & YOMI PARSING ENGINE (UNIFIED & BALANCED)
// Optimierte Balance: Verhindert False-Positives durch strikte Wortgrenzen, 
// erlaubt aber Smart-Prefix-Matches fuer abgekuerzte Uploader-Titel.
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

    for (const title of searchTitles) {
        if (!title) continue;
        const cleanTitle = normalizeTitle(title);
        if (!cleanTitle) continue;

        // 1. Exakter Boundary Match (Bester Schutz)
        const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?:^|\\s)${escapedTitle}(?:\\s|$)`, "i");
        if (regex.test(stripped)) return true;

        // 2. No-Space Match (Fuer "NatsutoHako") - Strikter ab 8 Zeichen
        const cleanNoSpaces = cleanTitle.replace(/\s+/g, "");
        if (cleanNoSpaces.length >= 8 && strippedNoSpaces.includes(cleanNoSpaces)) {
            return true;
        }

        // 3. Smart-Prefix Match (Fuer Abkuerzungen wie "Android wa Keiken")
        const words = cleanTitle.split(/\s+/);
        if (words.length >= 3) {
            // Wir verlangen, dass mindestens die ersten 3 Woerter exakt passen
            const prefix = words.slice(0, 3).join(" ");
            const prefixEscaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const prefixRegex = new RegExp(`(?:^|\\s)${prefixEscaped}(?:\\s|$)`, "i");
            
            if (prefixRegex.test(stripped)) {
                // Wenn es ein Prefix-Match ist, darf der Torrent-Name nicht 
                // voellig andere Woerter enthalten (z.B. "Android wa Keiken ... VOLLIG ANDERER ANIME")
                // Wir checken die Wortdichte
                const strippedWords = stripped.split(/\s+/).length;
                if (strippedWords <= words.length + 4) return true;
            }
        }
    }
    return false;
}

// ... (Rest der Funktionen extractEpisodeNumber, etc. bleibt gleich wie in Version 46)

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
