export interface Env {
  SICKW_API_KEY: string;
  SICKW_SERVICE_ID?: string; // default → 61
}

const PRICES_CSV_URL = "https://allenslists.pages.dev/data/prices.csv";

/* ---------------- CSV parser ---------------- */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let i = 0, field = "", row: string[] = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };
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
      if (c === '\r') { i++; continue; }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      field += c; i++; continue;
    }
  }
  pushField(); if (row.length > 1 || row[0] !== "") pushRow();

  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.map(r => {
    const obj: Record<string,string> = {};
    header.forEach((h, idx) => obj[h] = (r[idx] ?? "").trim());
    return obj;
  });
}

/* ---------------- Text helpers ---------------- */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0] = i;
  for (let j=0;j<=n;j++) dp[0][j] = j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) {
    const cost = a[i-1] === b[j-1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
  }
  return dp[m][n];
}

/* ---------------- Model Description parsing ---------------- */
function parseModelDescription(desc: string | null) {
  // Example: "IPHONE 16 PRO DESERT 256GB-USA"
  if (!desc) return { deviceName: null, color: null, storageGb: null };
  const up = desc.toUpperCase().replace(/[^A-Z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const cleaned = up.replace(/-?[A-Z]{2,3}\s*$/, "").trim(); // strip region like -USA

  const storageMatch = cleaned.match(/(\d{2,4})\s*GB\b/);
  const storageGb = storageMatch ? `${storageMatch[1]}GB` : null;

  const COLORS = ["BLACK","WHITE","BLUE","PINK","PURPLE","GOLD","DESERT","TITANIUM","NATURAL","GREEN","RED","YELLOW","SILVER","MIDNIGHT","STARLIGHT"];
  let color: string | null = null;
  for (const c of COLORS) {
    const re = new RegExp(`\\b${c}\\b`, "i");
    if (re.test(cleaned)) { color = c.charAt(0) + c.slice(1).toLowerCase(); break; }
  }

  const toks = cleaned.split(/\s+/);
  const iIdx = toks.indexOf("IPHONE");
  let deviceName: string | null = null;
  if (iIdx !== -1) {
    const take = toks.slice(iIdx, iIdx + 6); // IPHONE 16 PRO MAX ...
    const stop = new Set(["BLACK","WHITE","BLUE","PINK","PURPLE","GOLD","DESERT","TITANIUM","NATURAL","GREEN","RED","YELLOW","SILVER","MIDNIGHT","STARLIGHT","GB"]);
    const keep: string[] = [];
    for (const t of take) {
      if (/^\d+GB$/.test(t)) break;
      if (stop.has(t)) break;
      keep.push(t);
    }
    deviceName = keep.map((t, j) => j === 0 ? "iPhone" : t.charAt(0) + t.slice(1).toLowerCase()).join(" ")
                     .replace(/\bPro\b\s+Max\b/i, "Pro Max");
  }

  return { deviceName, color, storageGb };
}

/* --------- iPhone signature parsing --------- */
type Tier = "base" | "plus" | "pro" | "promax" | "e" | null;

function parseIphoneSignature(text: string | null) {
  if (!text) return { gen: null as number|null, tier: null as Tier, storage: null as number|null, color: null as string|null };
  const s = text.toUpperCase();

  const g = s.match(/\b(1[0-9]|[6-9])\b/);
  const gen = g ? parseInt(g[1], 10) : null;

  let tier: Tier = null;
  if (/\bPRO\s*MAX\b/.test(s)) tier = "promax";
  else if (/\bPRO\b/.test(s))  tier = "pro";
  else if (/\bPLUS\b/.test(s)) tier = "plus";
  else if (/\bIPHONE\s*E\b|\b\se\b/.test(s) || /\b1[0-9]E\b/.test(s)) tier = "e";
  else tier = "base";

  const sm = s.match(/(\d{2,4})\s*GB\b/);
  const storage = sm ? parseInt(sm[1], 10) : null;

  const cm = s.match(/\b(BLACK|WHITE|BLUE|PINK|PURPLE|GOLD|DESERT|TITANIUM|NATURAL|GREEN|RED|YELLOW|SILVER|MIDNIGHT|STARLIGHT)\b/);
  const color = cm ? cm[1].charAt(0) + cm[1].slice(1).toLowerCase() : null;

  return { gen, tier, storage, color };
}

/* ---------------- Carrier & iCloud ---------------- */
function parseCarrier(obj: Record<string, any>): string | null {
  const preferred = ["carrier","network","locked carrier","original carrier","sold by","sold to","activation policy","sim","policy"];
  const known = [
    { key: "verizon", label: "Verizon" },
    { key: "t-mobile", label: "T-Mobile" },
    { key: "tmobile", label: "T-Mobile" },
    { key: "at&t", label: "AT&T" },
    { key: "att", label: "AT&T" },
    { key: "xfinity", label: "Xfinity" },
    { key: "spectrum", label: "Spectrum" },
    { key: "us cellular", label: "US Cellular" },
    { key: "u.s. cellular", label: "US Cellular" },
    { key: "cricket", label: "Cricket" },
    { key: "unlocked", label: "Unlocked" },
    { key: "factory unlocked", label: "Unlocked" },
  ];
  const entries = Object.entries(obj || {});
  for (const [k,v] of entries) {
    const kk = String(k).toLowerCase();
    const vv = String(v ?? "").toLowerCase();
    if ((kk.includes("sim") || kk.includes("lock")) && vv.includes("unlock")) return "Unlocked";
  }
  for (const [k,v] of entries) {
    const kk = String(k).toLowerCase();
    const vv = String(v ?? "").toLowerCase();
    if (!preferred.some(p => kk.includes(p))) continue;
    for (const c of known) if (vv.includes(c.key)) return c.label;
  }
  for (const [,v] of entries) {
    const vv = String(v ?? "").toLowerCase();
    for (const c of known) if (vv.includes(c.key)) return c.label;
  }
  return null;
}
function hasIcloudOn(obj: Record<string, any>): boolean {
  for (const [k,v] of Object.entries(obj || {})) {
    const kk = String(k).toLowerCase();
    const vv = String(v ?? "").toLowerCase();
    if (kk.includes("icloud") || kk.includes("fmi")) {
      if (vv.includes("on") || vv.includes("enabled")) return true;
    }
  }
  return false;
}

/* ---------------- Purchase date parsing ---------------- */
function parseDateLoose(s: string): Date | null {
  const t = s.trim();
  const d1 = new Date(t);
  if (!isNaN(+d1)) return d1;

  const m = t.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if (m) {
    const a = parseInt(m[1],10), b = parseInt(m[2],10), c = parseInt(m[3],10);
    if (m[1].length === 4) return new Date(a, b-1, c);             // YYYY-M-D
    if (m[3].length === 4) {                                       // M/D/Y or D/M/Y
      const Y = c;
      if (a > 12) return new Date(Y, b-1, a); else return new Date(Y, a-1, b);
    }
  }
  return null;
}
function extractEstimatedPurchaseDate(obj: Record<string, any>) {
  let raw: string | null = null;
  for (const [k,v] of Object.entries(obj || {})) {
    const kk = String(k).toLowerCase().replace(/[:\s]+/g,' ').trim();
    if (kk.includes("estimated purchase date")) { raw = String(v ?? "").trim(); break; }
  }
  if (!raw) return { iso: null as string|null, ageDays: null as number|null, hint: null as "check_for_use"|"assume_used"|null };

  const dt = parseDateLoose(raw);
  if (!dt) return { iso: null, ageDays: null, hint: null };

  const age = Math.floor((Date.now() - dt.getTime()) / 86400000);
  let hint: "check_for_use"|"assume_used"|null = null;
  if (age > 45) hint = "assume_used"; else if (age > 14) hint = "check_for_use";
  return { iso: dt.toISOString().slice(0,10), ageDays: age, hint };
}

/* ---------------- Sickw fetch ---------------- */
async function sickwFetch(env: Env, imei: string) {
  const url = new URL("https://sickw.com/api.php");
  url.searchParams.set("format", "beta");
  url.searchParams.set("key", env.SICKW_API_KEY);
  url.searchParams.set("imei", imei);
  url.searchParams.set("service", env.SICKW_SERVICE_ID || "61"); // default 61

  const r = await fetch(url.toString(), { headers: { "accept": "application/json" }});
  if (!r.ok) throw new Error(`Sickw HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== "success") throw new Error(typeof j.result === "string" ? j.result : JSON.stringify(j));

  const res = j.result || {};
  const manufacturer = res.Manufacturer || null;
  const modelCode   = res["Model Code"] || null;
  const modelName   = res["Model Name"] || null;
  const modelDesc   = res["Model Description"] || null;

  const md = parseModelDescription(modelDesc);
  const display = md.deviceName
    ? md.deviceName
    : `${manufacturer ? manufacturer+" " : ""}${modelName || modelCode || ""}`.trim();

  const carrier  = parseCarrier(res) || "Unknown";
  const icloudOn = hasIcloudOn(res);
  const sig      = parseIphoneSignature([modelDesc, display].filter(Boolean).join(" "));
  const purch    = extractEstimatedPurchaseDate(res);

  return {
    imei: res.IMEI || j.imei || imei,
    manufacturer,
    model_code: modelCode,
    model_name: modelName,
    device_display: display,
    color: md.color,
    storage: md.storageGb, // "256GB"
    carrier,
    icloud_lock_on: icloudOn,
    sig, // {gen, tier, storage, color}
    estimated_purchase_date: purch.iso,
    estimated_purchase_age_days: purch.ageDays,
    condition_hint: purch.hint
  };
}

/* ---------------- Sheet selection (PRIORITIZED) ---------------- */
function isWatchOrAirpodsSheet(sheetName?: string) {
  if (!sheetName) return false;
  const s = sheetName.toLowerCase();
  return s.includes("watch") || s.includes("airpod");
}

/** Return pattern GROUPS in priority order */
function sheetPatternGroupsFor(brand: "apple"|"samsung"|"other", isUsed: boolean, carrier: string): RegExp[][] {
  const unlocked = carrier.toLowerCase() === "unlocked";

  if (brand === "apple") {
    if (isUsed) {
      if (unlocked) {
        return [
          [/iphone.*used.*unlock/i, /unlock.*iphone.*used/i, /used.*iphone.*unlock/i], // USED UNLOCKED
          [/iphone.*used(?!.*unlock)/i],                                              // USED generic/locked
          [/iphone.*used/i]
        ];
      } else {
        return [
          [/iphone.*used(?!.*unlock)/i], // USED LOCKED (prefer)
          [/iphone.*used/i]
        ];
      }
    } else {
      if (unlocked) {
        return [
          [/iphone.*unlock(?!.*used)/i],          // NEW UNLOCKED
          [/^iphone(?!.*unlock)(?!.*used)/i]      // fallback: non-unlocked, non-used
        ];
      } else {
        return [
          [/^iphone(?!.*unlock)(?!.*used)/i],     // NEW LOCKED
          [/iphone(?!.*used)/i]
        ];
      }
    }
  }

  if (brand === "samsung") {
    if (isUsed) {
      if (unlocked) {
        return [
          [/samsung.*used.*unlock/i, /unlock.*samsung.*used/i],
          [/samsung.*used(?!.*unlock)/i],
          [/samsung.*used/i]
        ];
      } else {
        return [
          [/samsung.*used(?!.*unlock)/i],
          [/samsung.*used/i]
        ];
      }
    } else {
      if (unlocked) {
        return [
          [/samsung.*unlock(?!.*used)/i],
          [/^samsung(?!.*used)/i]
        ];
      } else {
        return [
          [/^samsung(?!.*unlock)(?!.*used)/i],
          [/^samsung(?!.*used)/i]
        ];
      }
    }
  }

  // Fallback brand
  return isUsed
    ? [[/used.*unlocked/i], [/used(?!.*unlock)/i], [/used/i]]
    : [[/unlock(?!.*used)/i], [/^(?!.*used).*/i]];
}

/* ---------------- Price matching ---------------- */
function parseRowSignature(rowDevice: string) { return parseIphoneSignature(rowDevice); }

function scoreMatchStrict(target: ReturnType<typeof parseIphoneSignature>, cand: ReturnType<typeof parseIphoneSignature>) {
  if (target.gen && cand.gen && target.gen !== cand.gen) return -Infinity;
  if (target.tier && cand.tier && target.tier !== cand.tier) return -Infinity;
  let score = 0.5;
  if (target.storage && cand.storage && target.storage === cand.storage) score += 0.35;
  return score;
}
function scoreMatchRelaxed(target: ReturnType<typeof parseIphoneSignature>, cand: ReturnType<typeof parseIphoneSignature>, nameScore: number) {
  if (target.gen && cand.gen && target.gen !== cand.gen) return -Infinity;
  let score = 0.3 * nameScore;
  if (target.tier && cand.tier && target.tier === target.tier) score += 0.2;
  if (target.storage && cand.storage && target.storage === cand.storage) score += 0.2;
  return score;
}

function pickCandidatesByPriority(priceRows: Record<string,string>[], patternGroups: RegExp[][]) {
  for (const group of patternGroups) {
    const subset = priceRows.filter(r => {
      const sheet = (r.sheet || "");
      if (isWatchOrAirpodsSheet(sheet)) return false;
      return group.some(re => re.test(sheet));
    });
    if (subset.length) return subset;
  }
  // fallback: anything non-watch/airpods
  return priceRows.filter(r => !isWatchOrAirpodsSheet(r.sheet));
}

function bestPriceMatchSmart(
  devName: string,
  storage: string | null,
  carrier: string,
  brand: "apple"|"samsung"|"other",
  isUsed: boolean,
  targetSig: ReturnType<typeof parseIphoneSignature>,
  priceRows: Record<string,string>[]
) {
  const patternGroups = sheetPatternGroupsFor(brand, isUsed, carrier);
  const candidates = pickCandidatesByPriority(priceRows, patternGroups);
  const targetNorm = norm(devName);

  if (brand === "apple") {
    // strict (same gen + same tier)
    let best: Record<string,string> | null = null;
    let bestScore = -Infinity;
    for (const row of candidates) {
      const dev = (row["device"] || "");
      if (!dev) continue;
      const candSig = parseRowSignature(dev);
      const s = scoreMatchStrict(targetSig, candSig);
      if (s === -Infinity) continue;

      const hay = norm(dev);
      let nameScore = 0.0;
      if (hay.includes(targetNorm) || targetNorm.includes(hay)) nameScore = 1.0;
      else {
        const len = Math.max(hay.length, targetNorm.length);
        const d = lev(hay, targetNorm);
        nameScore = 1 - Math.min(1, d / Math.max(1, len));
      }
      const total = s + 0.15 * nameScore;
      if (total > bestScore) { bestScore = total; best = row; }
    }
    if (best) {
      const purchase_cents = parseInt(best["purchase_price_cents"] || "0", 10) || 0;
      const base_cents     = parseInt(best["base_price_cents"] || "0", 10) || 0;
      return {
        match: best,
        confidence: Math.round(bestScore * 1000) / 1000,
        purchase_price_cents: purchase_cents,
        purchase_price_dollars: Math.round(purchase_cents / 100),
        base_price_cents: base_cents
      };
    }

    // relaxed
    best = null; bestScore = -Infinity;
    for (const row of candidates) {
      const dev = (row["device"] || "");
      if (!dev) continue;
      const candSig = parseRowSignature(dev);

      const hay = norm(dev);
      let nameScore = 0.0;
      if (hay.includes(targetNorm) || targetNorm.includes(hay)) nameScore = 1.0;
      else {
        const len = Math.max(hay.length, targetNorm.length);
        const d = lev(hay, targetNorm);
        nameScore = 1 - Math.min(1, d / Math.max(1, len));
      }

      const total = scoreMatchRelaxed(targetSig, candSig, nameScore);
      if (total === -Infinity) continue;

      if (total > bestScore) { bestScore = total; best = row; }
    }
    if (best) {
      const purchase_cents = parseInt(best["purchase_price_cents"] || "0", 10) || 0;
      const base_cents     = parseInt(best["base_price_cents"] || "0", 10) || 0;
      return {
        match: best,
        confidence: Math.round(bestScore * 1000) / 1000,
        purchase_price_cents: purchase_cents,
        purchase_price_dollars: Math.round(purchase_cents / 100),
        base_price_cents: base_cents
      };
    }
  } else {
    // Samsung/Other: name similarity + storage boost
    let best: Record<string,string> | null = null;
    let bestScore = -Infinity;
    for (const row of candidates) {
      const dev = (row["device"] || "");
      if (!dev) continue;
      const hay = norm(dev);
      let score = 0.0;
      if (hay.includes(targetNorm) || targetNorm.includes(hay)) score = 0.8;
      else {
        const len = Math.max(hay.length, targetNorm.length);
        const d = lev(hay, targetNorm);
        score = 0.8 * (1 - Math.min(1, d / Math.max(1, len)));
      }
      if (storage) {
        const sNorm = storage.replace(/\s+/g, "").toLowerCase(); // "256gb"
        if (hay.includes(sNorm) || dev.toLowerCase().includes(sNorm)) score += 0.15;
      }
      if (carrier.toLowerCase() === "unlocked" && (hay.includes("unlock") || hay.includes("unlocked"))) score += 0.05;
      if (score > bestScore) { bestScore = score; best = row; }
    }
    if (best) {
      const purchase_cents = parseInt(best["purchase_price_cents"] || "0", 10) || 0;
      const base_cents     = parseInt(best["base_price_cents"] || "0", 10) || 0;
      return {
        match: best,
        confidence: Math.round(bestScore * 1000) / 1000,
        purchase_price_cents: purchase_cents,
        purchase_price_dollars: Math.round(purchase_cents / 100),
        base_price_cents: base_cents
      };
    }
  }

  return { match: null, confidence: 0, purchase_price_cents: 0, purchase_price_dollars: 0, base_price_cents: 0 };
}

/* ---------------- Handler ---------------- */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };

  try {
    const body = await request.json().catch(()=> ({}));
    const imeisIn: string[] = Array.isArray(body?.imeis) ? body.imeis : [];
    if (!imeisIn.length) {
      return new Response(JSON.stringify({ error: "Provide { imeis: [...] }" }), { status: 400, headers: { ...cors, "content-type":"application/json" }});
    }

    // Detect trailing 'u' = used; strip before Sickw lookup
    const parsed = imeisIn.slice(0, 200).map(raw => {
      const t = String(raw).trim();
      const usedOverride = /u$/i.test(t);
      const trimmed = usedOverride ? t.slice(0, -1).trim() : t;
      const imei = trimmed.replace(/\s+/g,'');
      return { raw: t, imei, usedOverride };
    });

    // prices.csv once
    const pricesResp = await fetch(PRICES_CSV_URL, { headers: { "accept": "text/csv" }});
    if (!pricesResp.ok) throw new Error(`prices.csv HTTP ${pricesResp.status}`);
    const csvText = await pricesResp.text();
    const priceRows = parseCSV(csvText);

    const items: any[] = [];
    for (const rec of parsed) {
      try {
        const dev = await sickwFetch(env, rec.imei);

        // Brand detection
        const man = (dev.manufacturer || "").toLowerCase();
        const brand: "apple"|"samsung"|"other" =
          man.includes("apple") ? "apple" : man.includes("samsung") ? "samsung" : "other";

        // Used?
        const isUsed = rec.usedOverride || dev.condition_hint === "assume_used";

        const pricing = bestPriceMatchSmart(
          dev.device_display,
          dev.storage,
          dev.carrier || "Unknown",
          brand,
          isUsed,
          dev.sig,
          priceRows
        );

        items.push({
          ok: true,
          imei: dev.imei,
          manufacturer: dev.manufacturer,
          model_name: dev.model_name,
          model_code: dev.model_code,
          device_display: dev.device_display,
          color: dev.color,
          storage: dev.storage,
          carrier: dev.carrier,
          icloud_lock_on: dev.icloud_lock_on,
          match_device: pricing.match?.device || null,
          match_sheet: pricing.match?.sheet || null,
          base_price_cents: pricing.base_price_cents || null, // hidden on UI
          suggested_price_cents: pricing.purchase_price_cents || null,
          suggested_price_dollars: pricing.purchase_price_dollars || null,
          confidence: pricing.confidence || 0,
          estimated_purchase_date: dev.estimated_purchase_date,
          estimated_purchase_age_days: dev.estimated_purchase_age_days,
          condition_hint: dev.condition_hint,
          used: isUsed,
          used_source: rec.usedOverride ? "flag" : (dev.condition_hint === "assume_used" ? "date" : "")
        });
      } catch (e: any) {
        items.push({ ok: false, imei: rec.imei, error: String(e?.message || e) });
      }
      await new Promise(r => setTimeout(r, 150));
    }

    return new Response(JSON.stringify({
      imported: items.filter(x=>x.ok).length,
      failed:   items.filter(x=>!x.ok).length,
      items
    }), { headers: { ...cors, "content-type": "application/json" }});
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { ...cors, "content-type":"application/json" }});
  }
};

export const onRequestOptions: PagesFunction = async () =>
  new Response("", { headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  }});
