/**
 * Inventory Intake API - Optimized version
 * - Uses shared utility functions
 * - Improved device matching
 * - Better error handling and caching
 * - Parallel processing for better performance
 */

import { fetchCSV, toCents } from '../utils/csv.js';
import { normalize, titleCase, escapeRegExp } from '../utils/string.js';
import { inferBrand, extractStorage, extractColor, variantKey } from '../utils/device-matcher.js';
import { jsonResponse, error } from '../utils/api.js';
import { batchProcess, memoize } from '../utils/cache.js';

// Memoize the fetchCSV function to avoid redundant fetches
const memoizedFetchCSV = memoize(
  (url) => fetchCSV(url, { cache: { cacheTtl: 300 } }),
  (args) => args[0],
  300 // 5 minute cache
);

/**
 * Handle POST requests for device intake
 */
export async function onRequestPost(context) {
  try {
    // Get API key from environment or fallback
    const API_KEY = context.env?.SICKW_KEY || "X5Q-O0T-R0J-15X-RG5-1E2-ZX9-2ZN";
    const SERVICE_ID = "61"; // as requested
    
    // Parse request body
    const req = await context.request.json();
    const imeis = Array.isArray(req?.imeis) ? req.imeis : [];
    
    if (!imeis.length) {
      return error("No IMEIs supplied", 400);
    }

    // Fetch CSV once (cached)
    const pricesCsv = await memoizedFetchCSV("https://allenslists.pages.dev/data/prices.csv");

    // Process IMEIs in batches with controlled concurrency
    const results = await batchProcess(
      imeis.slice(0, 200), // Limit to 200 IMEIs
      async (raw) => {
        try {
          // Parse IMEI and check for used flag
          const { imei, usedFlag } = cleanImei(raw);
          
          // Fetch device info from API
          const apiUrl = `https://sickw.com/api.php?format=beta&key=${encodeURIComponent(API_KEY)}&imei=${encodeURIComponent(imei)}&service=${encodeURIComponent(SERVICE_ID)}`;
          const apiJson = await fetchDeviceInfo(apiUrl);
          
          if (!apiJson || apiJson.status === "error") {
            return { 
              ok: false, 
              imei, 
              error: apiJson?.result || apiJson?.status || "API error" 
            };
          }

          // Process device information
          const res = normalizeSickw(apiJson);
          
          // Extract device details
          const parsed = parseModelDescription(res.model_description || "", pricesCsv.colorList);
          const device_display = pickDisplayName(res, parsed);
          
          // Determine carrier and lock status
          const carrier = normalizeCarrier(res, apiJson);
          const isUnlocked = carrier === "Unlocked";
          
          // Check for iCloud lock
          const icloud_lock_on = inferIcloud(res, apiJson);
          
          // Analyze purchase date
          const { estimated_purchase_date, estimated_purchase_age_days, condition_hint } = computePurchaseHints(res);
          
          // Determine if device is used
          const used = usedFlag || condition_hint === "assume_used";
          const used_source = usedFlag ? "suffix_u" : (condition_hint === "assume_used" ? "age>45" : "");
          
          // Get device brand and storage
          const brand = inferBrand(device_display);
          const storage = parsed.storage || res.storage || "";
          
          // Get pricing variants
          const variants = getVariantsFor({
            q: device_display, storage, brand, csv: pricesCsv
          });
          
          // Choose default price based on condition and carrier
          const key = variantKey(used ? "Used" : "New", isUnlocked ? "Unlocked" : "Locked");
          const suggested_price_cents = (variants && typeof variants[key] === "number") ? variants[key] : undefined;
          const suggested_price_dollars = typeof suggested_price_cents === "number" ? Math.round(suggested_price_cents) / 100 : undefined;
          
          // Return complete device information
          return {
            ok: true,
            imei,
            manufacturer: res.manufacturer || "",
            model_name: res.model_name || "",
            model_code: res.model_code || "",
            model_description: res.model_description || "",
            device_display,
            color: parsed.color || res.color || "",
            storage,
            carrier,
            icloud_lock_on,
            estimated_purchase_date,
            estimated_purchase_age_days,
            condition_hint,   // "check_for_use" (>=14d) or "assume_used" (>45d) or ""
            used,
            used_source,
            match_device: variants?.match_device || "",
            match_sheet: variants?.match_sheet || "",
            suggested_price_cents,
            suggested_price_dollars,
            ui: {
              condition: used ? "Used" : "New",
              carrier: carrier || "Unlocked",
              storage: storage || "",
              variants // { NEW_UNLOCKED, NEW_LOCKED, USED_UNLOCKED, USED_LOCKED }
            }
          };
        } catch (e) {
          console.error(`Error processing IMEI ${raw}:`, e);
          return { ok: false, imei: raw, error: e.message || "Processing error" };
        }
      },
      {
        concurrency: 5, // Process 5 IMEIs at a time
        delayMs: 200   // 200ms delay between requests to avoid rate limiting
      }
    );

    return jsonResponse({ items: results });
  } catch (e) {
    console.error('Intake API error:', e);
    return error(e);
  }
}

/**
 * Fetch device information from API
 * @param {string} url - API URL
 * @returns {Promise<Object>} Device information
 */
async function fetchDeviceInfo(url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 } });
    const txt = await r.text();
    return safeJson(txt);
  } catch (e) {
    throw new Error("Lookup failed: " + (e.message || "Network error"));
  }
}

/**
 * Parse JSON safely
 * @param {string} text - JSON text
 * @returns {Object|null} Parsed JSON or null
 */
function safeJson(text) {
  try { 
    return JSON.parse(text); 
  } catch (_){ 
    return null; 
  }
}

/**
 * Clean IMEI string and check for used flag
 * @param {string} s - Raw IMEI string
 * @returns {Object} Cleaned IMEI and used flag
 */
function cleanImei(s) {
  const trimmed = String(s || "").trim();
  const usedFlag = /u$/i.test(trimmed);
  const imei = trimmed.replace(/[^0-9A-Za-z]/g, "").replace(/u$/i, "");
  return { imei, usedFlag };
}

/**
 * Normalize carrier information
 * @param {Object} res - Device information
 * @param {Object} apiJson - Raw API response
 * @returns {string} Normalized carrier name
 */
function normalizeCarrier(res, apiJson) {
  // Check common fields and free-text for carrier / lock.
  const candidates = [
    res.carrier, res.sold_by, res.sold_to, res.network, res.lock, res.simlock
  ].filter(Boolean).map(x => String(x).toLowerCase());

  const full = JSON.stringify(apiJson).toLowerCase();
  if (candidates.some(x => x.includes("unlock")) || full.includes("sim-lock: unlocked") || full.includes("sim lock: unlocked")) return "Unlocked";
  
  const known = ["verizon","t-mobile","tmobile","at&t","att","xfinity","spectrum","us cellular","cricket"];
  for (const k of known) {
    if (candidates.some(x => x.includes(k)) || full.includes(k)) {
      if (k === "tmobile") return "T-Mobile";
      if (k === "att" || k === "at&t") return "AT&T";
      return titleCase(k);
    }
  }
  
  return "Unlocked"; // default safe
}

/**
 * Check if device has iCloud lock
 * @param {Object} res - Device information
 * @param {Object} apiJson - Raw API response
 * @returns {boolean} True if iCloud lock is on
 */
function inferIcloud(res, apiJson) {
  const txt = (JSON.stringify(apiJson) + " " + Object.values(res).join(" ")).toLowerCase();
  return /icloud[^a-z0-9]{0,5}(on|locked|lock:\s*on)/.test(txt);
}

/**
 * Choose best display name for device
 * @param {Object} res - Device information
 * @param {Object} parsed - Parsed model description
 * @returns {string} Display name
 */
function pickDisplayName(res, parsed) {
  // Prefer richer Model Name if available; fallback to parsed or code
  const name = (res.model_name || "").trim();
  if (name) return titleCase(name.replace(/\s+/g,' ').replace(/\biphones?\b/i,"iPhone"));
  
  const md = (parsed?.device || "").trim();
  if (md) return md;
  
  const code = (res.model_code || "").trim();
  if (code) return code;
  
  return "Unknown Device";
}

/**
 * Analyze purchase date information
 * @param {Object} res - Device information
 * @returns {Object} Purchase date analysis
 */
function computePurchaseHints(res) {
  let dstr = res.estimated_purchase_date || res.purchase_date || "";
  let estimated_purchase_date = dstr ? dstr : "";
  let estimated_purchase_age_days = undefined;
  let condition_hint = "";
  
  if (dstr) {
    const d = new Date(dstr);
    if (!isNaN(d.getTime())) {
      const now = new Date();
      const diff = Math.floor((now - d) / (1000*60*60*24));
      estimated_purchase_age_days = diff;
      if (diff > 45) condition_hint = "assume_used";
      else if (diff >= 14) condition_hint = "check_for_use";
    }
  }
  
  return { estimated_purchase_date, estimated_purchase_age_days, condition_hint };
}

/**
 * Parse model description to extract device, color, and storage
 * @param {string} desc - Model description
 * @param {Array<string>} colorList - List of known colors
 * @returns {Object} Parsed device information
 */
function parseModelDescription(desc, colorList) {
  const s = String(desc || "").replace(/[-_]/g, " ").replace(/\s+/g," ").trim();
  if (!s) return { device:"", color:"", storage:"" };
  
  // Extract storage
  const storageMatch = s.match(/\b(\d{2,4})\s*GB\b|\b([12])\s*TB\b/i);
  const storage = storageMatch ? (storageMatch[1] ? storageMatch[1]+"GB" : storageMatch[2]+"TB") : "";

  // Extract color
  let color = "";
  if (Array.isArray(colorList)) {
    const upper = " " + s.toUpperCase() + " ";
    for (const c of colorList) {
      const re = new RegExp(`[^A-Z0-9]${escapeRegExp(c.toUpperCase())}[^A-Z0-9]`);
      if (re.test(upper)) { color = c; break; }
    }
  }

  // Extract device name
  let device = s.replace(/\b(usa|us|global|intl|international)\b/ig,"");
  if (storage) device = device.replace(new RegExp("\\b"+escapeRegExp(storage)+"\\b","i"), "");
  if (color) device = device.replace(new RegExp("\\b"+escapeRegExp(color)+"\\b","i"), "");
  device = device.replace(/\s+/g," ").trim();
  device = device.replace(/\bIPHONE\b/ig,"iPhone")
                 .replace(/\bPRO MAX\b/g,"Pro Max")
                 .replace(/\bPRO\b/g,"Pro")
                 .replace(/\bPLUS\b/g,"Plus")
                 .replace(/\bMINI\b/g,"Mini");
                 
  return { device: titleCase(device), color, storage };
}

/**
 * Get pricing variants for a device
 * @param {Object} params - Search parameters
 * @returns {Object} Pricing variants
 */
function getVariantsFor({ q, storage, brand, csv }) {
  const { rows, idx } = csv;
  const qNorm = normalize(q);
  const storageNorm = normalize(storage);

  const groups = { NEW_UNLOCKED: [], NEW_LOCKED: [], USED_UNLOCKED: [], USED_LOCKED: [] };

  // Filter and score rows
  for (const r of rows) {
    const sheet = r.sheet || "";
    const device = r.device || "";
    const price_cents = toCents(r.price_cents || r.price || "");

    const devNorm = normalize(device);
    const sheetNorm = normalize(sheet);

    // Brand filter
    if (brand) {
      if (brand === "apple" && !sheetNorm.includes("iphone") && !devNorm.includes("iphone")) continue;
      if (brand === "samsung" && !sheetNorm.includes("samsung") && !devNorm.includes("samsung")) continue;
    }

    // Storage filter
    if (storageNorm && !devNorm.includes(storageNorm)) continue;

    // Score match
    const score = scoreMatch(qNorm, devNorm);
    if (score <= 0) continue;

    // Determine sheet key
    const key = sheetKey(sheetNorm);
    if (!key) continue;
    
    groups[key].push({ device, sheet, price_cents, score });
  }

  // Find best match in each group
  function bestOf(arr) { 
    if (!arr.length) return null;
    return arr.sort((a,b) => b.score - a.score || a.price_cents - b.price_cents)[0]; 
  }

  // Build result object
  const out = {};
  let bestLabel = null;
  let bestSheet = null;
  let bestScore = -1;
  
  for (const k of Object.keys(groups)) {
    const best = bestOf(groups[k] || []);
    if (best) {
      out[k] = best.price_cents;
      if (best.score > bestScore) {
        bestScore = best.score; 
        bestLabel = best.device; 
        bestSheet = best.sheet;
      }
    }
  }
  
  if (bestLabel) { 
    out.match_device = bestLabel; 
    out.match_sheet = bestSheet; 
  }
  
  return out;
}

/**
 * Score a match between query and device name
 * @param {string} q - Query string
 * @param {string} dev - Device name
 * @returns {number} Match score
 */
function scoreMatch(q, dev) {
  if (!q || !dev) return 0;
  
  let score = 0;
  const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  
  // Score token matches
  for (const t of qTokens) {
    if (dev.includes(t)) score += (t.length >= 3 ? 2 : 1);
  }
  
  // Bonus for all tokens found
  const allFound = qTokens.every(t => dev.includes(t));
  if (allFound) score += 3;
  
  return score;
}

/**
 * Determine sheet key from sheet name
 * @param {string} sheetNorm - Normalized sheet name
 * @returns {string|null} Sheet key
 */
function sheetKey(sheetNorm) {
  const isIphone = sheetNorm.includes("iphone");
  const isSamsung = sheetNorm.includes("samsung");
  const isUsed = sheetNorm.includes("used");
  const isUnlocked = sheetNorm.includes("unlocked");
  const isLocked = sheetNorm.includes("locked") && !isUnlocked;
  
  if (!(isIphone || isSamsung)) return null;
  if (isUsed && isUnlocked) return "USED_UNLOCKED";
  if (isUsed && isLocked) return "USED_LOCKED";
  if (!isUsed && isUnlocked) return "NEW_UNLOCKED";
  if (!isUsed && isLocked) return "NEW_LOCKED";
  
  return null;
}

/**
 * Normalize Sickw API response
 * @param {Object} apiJson - Raw API response
 * @returns {Object} Normalized device information
 */
function normalizeSickw(apiJson) {
  const out = {};
  const res = apiJson?.result;
  if (!res) return out;

  if (typeof res === "object" && !Array.isArray(res)) {
    // Map keys loosely
    for (const [k, v] of Object.entries(res)) {
      const key = k.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      out[key] = v;
      if (k.toLowerCase().includes("manufacturer")) out.manufacturer = String(v);
      if (k.toLowerCase().includes("model name")) out.model_name = String(v);
      if (k.toLowerCase().includes("model code")) out.model_code = String(v);
      if (k.toLowerCase().includes("model description")) out.model_description = String(v);
      if (k.toLowerCase().includes("purchase date")) out.estimated_purchase_date = String(v);
      if (k.toLowerCase().includes("carrier")) out.carrier = String(v);
      if (k.toLowerCase().includes("sold by")) out.sold_by = String(v);
      if (k.toLowerCase().includes("sold to")) out.sold_to = String(v);
      if (k.toLowerCase().includes("network")) out.network = String(v);
      if (k.toLowerCase().includes("sim-lock")) out.simlock = String(v);
    }
  } else if (typeof res === "string") {
    // Parse simple "Key: Value<br>..." format
    const lines = res.replace(/<br\s*\/?>/gi,"\n").split(/\n+/);
    for (const line of lines) {
      const m = line.match(/^\s*([^:]+):\s*(.+)\s*$/);
      if (m) {
        const key = m[1].toLowerCase().replace(/[^a-z0-9]+/g,"_");
        out[key] = m[2];
        if (/manufacturer/i.test(m[1])) out.manufacturer = m[2];
        if (/model name/i.test(m[1])) out.model_name = m[2];
        if (/model code/i.test(m[1])) out.model_code = m[2];
        if (/model description/i.test(m[1])) out.model_description = m[2];
        if (/purchase date/i.test(m[1])) out.estimated_purchase_date = m[2];
        if (/carrier/i.test(m[1])) out.carrier = m[2];
        if (/sold by/i.test(m[1])) out.sold_by = m[2];
        if (/sold to/i.test(m[1])) out.sold_to = m[2];
        if (/network/i.test(m[1])) out.network = m[2];
        if (/sim-?lock/i.test(m[1])) out.simlock = m[2];
      }
    }
  }

  return out;
}