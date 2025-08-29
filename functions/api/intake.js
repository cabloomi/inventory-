export async function onRequestPost(context) {
  try {
    const API_KEY = context.env?.SICKW_KEY || "X5Q-O0T-R0J-15X-RG5-1E2-ZX9-2ZN";
    const SERVICE_ID = "61"; // as requested
    const req = await context.request.json();
    const imeis = Array.isArray(req?.imeis) ? req.imeis : [];
    if (!imeis.length) return json({ error: "No IMEIs supplied" }, 400);

    // Fetch CSV once (cached)
    const pricesCsv = await fetchCsv("https://allenslists.pages.dev/data/prices.csv");

    const results = [];
    for (const raw of imeis.slice(0, 200)) {
      const { imei, usedFlag } = cleanImei(raw);
      const apiUrl = `https://sickw.com/api.php?format=beta&key=${encodeURIComponent(API_KEY)}&imei=${encodeURIComponent(imei)}&service=${encodeURIComponent(SERVICE_ID)}`;
      let apiJson;
      try {
        const r = await fetch(apiUrl, { cf: { cacheTtl: 0 } });
        const txt = await r.text();
        apiJson = safeJson(txt);
      } catch (e) {
        results.push({ ok:false, imei, error: "Lookup failed" });
        continue;
      }

      if (!apiJson || apiJson.status === "error") {
        results.push({ ok:false, imei, error: apiJson?.result || apiJson?.status || "API error" });
        continue;
      }

      const res = normalizeSickw(apiJson);

      // parse model description for device/color/storage when possible
      const parsed = parseModelDescription(res.model_description || "", pricesCsv.colorList);
      const device_display = pickDisplayName(res, parsed);

      // carrier & lock
      const carrier = normalizeCarrier(res, apiJson);
      const isUnlocked = carrier === "Unlocked";

      // iCloud lock
      const icloud_lock_on = inferIcloud(res, apiJson);

      // purchase date heuristics
      const { estimated_purchase_date, estimated_purchase_age_days, condition_hint } = computePurchaseHints(res);

      // used flag from suffix or heuristic
      const used = usedFlag || condition_hint === "assume_used";
      const used_source = usedFlag ? "suffix_u" : (condition_hint === "assume_used" ? "age>45" : "");

      // variants from CSV (precompute all 4 to enable UI switching without extra calls)
      const brand = inferBrand(device_display);
      const storage = parsed.storage || res.storage || "";
      const variants = getVariantsFor({
        q: device_display, storage, brand, csv: pricesCsv
      });

      // choose default key based on used + carrier
      const key = variantKey(used ? "Used" : "New", isUnlocked ? "Unlocked" : "Locked");
      const suggested_price_cents = (variants && typeof variants[key] === "number") ? variants[key] : undefined;
      const suggested_price_dollars = typeof suggested_price_cents === "number" ? Math.round(suggested_price_cents) / 100 : undefined;

      results.push({
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
      });
    }

    return json({ items: results });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/* ---------------- Helpers ---------------- */

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_){ return null; }
}

function cleanImei(s) {
  const trimmed = String(s || "").trim();
  const usedFlag = /u$/i.test(trimmed);
  const imei = trimmed.replace(/[^0-9A-Za-z]/g, "").replace(/u$/i, "");
  return { imei, usedFlag };
}

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

function inferIcloud(res, apiJson) {
  const txt = (JSON.stringify(apiJson) + " " + Object.values(res).join(" ")).toLowerCase();
  return /icloud[^a-z0-9]{0,5}(on|locked|lock:\s*on)/.test(txt);
}

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

function parseModelDescription(desc, colorList) {
  const s = String(desc || "").replace(/[-_]/g, " ").replace(/\s+/g," ").trim();
  if (!s) return { device:"", color:"", storage:"" };
  const storageMatch = s.match(/\b(\d{2,4})\s*GB\b|\b([12])\s*TB\b/i);
  const storage = storageMatch ? (storageMatch[1] ? storageMatch[1]+"GB" : storageMatch[2]+"TB") : "";

  let color = "";
  if (Array.isArray(colorList)) {
    const upper = " " + s.toUpperCase() + " ";
    for (const c of colorList) {
      const re = new RegExp(`[^A-Z0-9]${escapeRegExp(c.toUpperCase())}[^A-Z0-9]`);
      if (re.test(upper)) { color = c; break; }
    }
  }

  // crude device string: remove color & storage & region tags like USA
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

function titleCase(str) {
  return String(str).toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).replace(/\bIphone\b/g,"iPhone");
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function inferBrand(name) {
  const s = (name||"").toLowerCase();
  if (s.includes("iphone") || s.includes("apple")) return "apple";
  if (s.includes("samsung") || s.includes("galaxy")) return "samsung";
  return "";
}

function variantKey(condition, carrier) {
  const lock = (carrier === "Unlocked") ? "UNLOCKED" : "LOCKED";
  return (condition || "New").toUpperCase() + "_" + lock; // NEW_UNLOCKED, USED_LOCKED, ...
}

/* ------------- CSV + Variant matching ------------- */

async function fetchCsv(url) {
  const resp = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!resp.ok) throw new Error("Failed to fetch prices.csv");
  const text = await resp.text();
  const rows = parseCSV(text);
  const header = rows.shift() || [];
  const idx = makeIndex(header);
  // build color list from devices heuristically
  const colorList = buildColorList(rows, idx);
  return { rows, header, idx, colorList };
}

function buildColorList(rows, idx) {
  const seen = new Set([
    // seed with curated list
    "Midnight","Starlight","Blue","Purple","Yellow","Red",
    "Deep Purple","Space Black","Silver","Gold",
    "Black","Light Blue","Light Green","Light Yellow","Light Pink","Pink","Green",
    "Natural Titanium","Blue Titanium","White Titanium","Black Titanium","Titanium",
    "Desert","Desert Titanium","Natural",
    "Phantom Black","Phantom White","Burgundy","Graphite","Sky Blue","Cream","Lavender","Lime",
    "Onyx Black","Marble Gray","Cobalt Violet","Amber Yellow",
    "Titanium Black","Titanium Gray","Titanium Violet","Titanium Yellow","Titanium Blue","Titanium Green","Titanium Orange"
  ]);
  for (const r of rows) {
    const dev = getField(r, idx, "device");
    const m = (dev||"").match(/\b([A-Z][a-z]+)\b/g);
    if (m) m.forEach(w => { if (w.length<=12) seen.add(w); });
  }
  return Array.from(seen).sort((a,b)=>a.localeCompare(b));
}

function getField(r, idx, name) {
  const i = idx[name]; return (i!=null) ? r[i] : "";
}

function getVariantsFor({ q, storage, brand, csv }) {
  const { rows, idx } = csv;
  const qNorm = normalize(q);
  const storageNorm = normalize(storage);

  const groups = { NEW_UNLOCKED: [], NEW_LOCKED: [], USED_UNLOCKED: [], USED_LOCKED: [] };

  for (const r of rows) {
    const sheet = getField(r, idx, "sheet") || getField(r, idx, "Sheet") || "";
    const device = getField(r, idx, "device") || getField(r, idx, "Device") || "";
    const pc = getField(r, idx, "price_cents") || getField(r, idx, "price") || "";
    const price_cents = toCents(pc);

    const devNorm = normalize(device);
    const sheetNorm = normalize(sheet);

    // brand gate
    if (brand) {
      if (brand === "apple" && !sheetNorm.includes("iphone") && !devNorm.includes("iphone")) continue;
      if (brand === "samsung" && !sheetNorm.includes("samsung") && !devNorm.includes("samsung")) continue;
    }

    if (storageNorm && !devNorm.includes(storageNorm)) continue;

    const score = scoreMatch(qNorm, devNorm);
    if (score <= 0) continue;

    const key = sheetKey(sheetNorm);
    if (!key) continue;
    groups[key].push({ device, sheet, price_cents, score });
  }

  function bestOf(arr) { return arr.sort((a,b)=> b.score - a.score || a.price_cents - b.price_cents)[0]; }

  const out = {};
  let bestLabel = null;
  let bestSheet = null;
  let bestScore = -1;
  for (const k of Object.keys(groups)) {
    const best = bestOf(groups[k] || []);
    if (best) {
      out[k] = best.price_cents;
      if (best.score > bestScore) {
        bestScore = best.score; bestLabel = best.device; bestSheet = best.sheet;
      }
    }
  }
  if (bestLabel) { out.match_device = bestLabel; out.match_sheet = bestSheet; }
  return out;
}

function toCents(val) {
  if (val == null) return 0;
  if (typeof val === "number") return val > 10000 ? Math.round(val) : Math.round(val*100);
  const n = Number(String(val).replace(/[^0-9.]/g, ""));
  if (!isNaN(n)) return n > 10000 ? Math.round(n) : Math.round(n*100);
  return 0;
}

function normalize(s) { return (s||"").toLowerCase().replace(/\s+/g,' ').trim(); }

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

function scoreMatch(q, dev) {
  if (!q || !dev) return 0;
  let score = 0;
  const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of qTokens) {
    if (dev.includes(t)) score += (t.length >= 3 ? 2 : 1);
  }
  const allFound = qTokens.every(t => dev.includes(t));
  if (allFound) score += 3;
  return score;
}

function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  function pushField(){ row.push(field); field=""; }
  function pushRow(){ rows.push(row); row = []; }
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      } else { field += c; i++; continue; }
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++;
    }
  }
  pushField(); pushRow();
  if (rows.length && rows[0].length && rows[0][0].charCodeAt(0) === 0xFEFF) {
    rows[0][0] = rows[0][0].slice(1);
  }
  return rows;
}

function makeIndex(header) {
  const map = {};
  header.forEach((h,i)=>{ map[(h||"").toString().trim().toLowerCase()] = i; });
  return {
    sheet: map["sheet"],
    Sheet: map["sheet"],
    device: map["device"],
    Device: map["device"],
    price_cents: map["price_cents"] != null ? map["price_cents"] : map["price"],
    price: map["price_cents"] != null ? map["price_cents"] : map["price"]
  };
}

function normalizeSickw(apiJson) {
  const out = {};
  const res = apiJson?.result;
  if (!res) return out;

  if (typeof res === "object" && !Array.isArray(res)) {
    // map keys loosely
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
    // parse simple "Key: Value<br>..." format
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
