//===============
// YOMI DEBRID PROVIDER INTERFACE
// This module manages communication with Debrid services (Real-Debrid & Torbox).
// Includes intelligent chunking, Promise deduplication, and LRU caching.
//===============

const axios = require("axios");

//===============
// IN-MEMORY CACHE & PROMISE DEDUPING
// A high-performance LRU cache to prevent 429 Too Many Requests errors.
//===============
const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const API_USER_AGENT = "Yomi/1.0";

const STREMTHRU_URL = process.env.STREMTHRU_URL || "https://stremthru.13377001.xyz";

// Utility function: Sets the cache with a dynamic TTL to rotate entries efficiently
function setCache(key, dataOrPromise, ttlMs = 60000) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { data: dataOrPromise, expiresAt: Date.now() + ttlMs });
}

// Utility function: Retrieves data and updates LRU position
function getCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (item.expiresAt > Date.now()) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else {
            apiCache.delete(key);
        }
    }
    return null;
}

//===============
// Checks Real-Debrid via StremThru Crowdsourced Cache.
// Uses deduplication to absorb parallel requests from Stremio pre-fetching.
//===============
async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    
    // Create a deterministic cache key based on the requested hashes
    const safeKey = (apiKey || "").trim();
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "rd_chk_st_" + safeKey.substring(0, 5) + "_" + hashKey;
    
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            
            // StremThru API erlaubt bis zu 500 hashes, wir nehmen 100 als sicheren Chunk
            const chunkSize = 100; 
            for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                const url = `${STREMTHRU_URL}/v0/store/torz/check?hash=${chunk.join(",")}`;
                
                const res = await axios.get(url, { 
                    headers: { 
                        "X-StremThru-Store-Name": "realdebrid",
                        "X-StremThru-Store-Authorization": `Bearer ${safeKey}`,
                        "User-Agent": API_USER_AGENT
                    },
                    timeout: 8000 
                });
                
                if (res.data && res.data.data && Array.isArray(res.data.data.items)) {
                    res.data.data.items.forEach(item => {
                        if (item.status === "cached") {
                            const mappedFiles = (item.files || []).map(f => ({
                                id: f.index !== undefined ? f.index : -1,
                                name: f.name || f.path || "Unknown",
                                size: f.size !== undefined ? f.size : 0
                            }));
                            results[item.hash.toLowerCase()] = mappedFiles;
                        }
                    });
                }
                
                if (i + chunkSize < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[StremThru RD Check Error] Error at checkRD: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) {
                errorTtl = 3600000; 
            } else if (status === 429) {
                errorTtl = 30000; 
            }
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 30000); 
    return fetchPromise;
}

//===============
// Checks Torbox for cached torrents.
// Also splits the request into secure blocks of 40 with caching.
//===============
async function checkTorbox(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};

    const hashKey = [...hashes].sort().join("");
    const cacheKey = "tb_chk_" + apiKey.substring(0, 5) + "_" + hashKey;
    
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            
            for (let i = 0; i < hashes.length; i += 40) {
                const chunk = hashes.slice(i, i + 40);
                const url = "https://api.torbox.app/v1/api/torrents/checkcached?hash=" + chunk.join(",") + "&format=list&list_files=true";
                const res = await axios.get(url, { headers: { Authorization: "Bearer " + apiKey } });
                
                if (res.data && res.data.data) {
                    res.data.data.forEach(t => {
                        results[t.hash.toLowerCase()] = t.files.map(f => ({ 
                            id: f.id, 
                            name: f.name, 
                            size: f.size 
                        }));
                    });
                }
                
                if (i + 40 < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Torbox Error] Error at checkTorbox: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 30000);
    return fetchPromise;
}

//===============
// Retrieves the current list of active torrents from Real-Debrid.
// Uses a strict 10-second TTL to ensure accurate progress reporting in the Stremio UI.
//===============
async function getActiveRD(apiKey) {
    const cacheKey = "rd_act_" + apiKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=100", { 
                headers: { Authorization: "Bearer " + apiKey } 
            });
            const active = {};
            
            res.data.forEach(t => {
                if (t.status === "downloaded") {
                    active[t.hash.toLowerCase()] = 100;
                } else if (t.status !== "error" && t.status !== "dead") {
                    active[t.hash.toLowerCase()] = t.progress || 0;
                }
            });
            return { data: active, ttl: 10000 }; // 10s TTL for live progression
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Real-Debrid Error] Error at getActiveRD: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

//===============
// Retrieves the current list of active torrents from Torbox.
// Uses a strict 10-second TTL to ensure accurate progress reporting in the Stremio UI.
//===============
async function getActiveTorbox(apiKey) {
    const cacheKey = "tb_act_" + apiKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { 
                headers: { Authorization: "Bearer " + apiKey } 
            });
            const active = {};
            
            if (res.data && res.data.data) {
                res.data.data.forEach(t => {
                    if (t.download_state === "completed" || t.download_state === "cached") {
                        active[t.hash.toLowerCase()] = 100;
                    } else {
                        let p = t.progress || 0;
                        if (p <= 1 && p > 0) p = p * 100;
                        active[t.hash.toLowerCase()] = Math.round(p);
                    }
                });
            }
            return { data: active, ttl: 10000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Torbox Error] Error at getActiveTorbox: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
