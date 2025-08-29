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
  const dp = Array.from({length: m+1}, (_, i)=> Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0] = i;
  for (let j=0;j<=n;j++) dp[0][j] = j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) {
    const cost = a[i-1] === b[j-1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
  }
  return dp[m][n];
}

/* ---------------- Sickw field parsing ---------------- */
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

  // make a nice device name from iPhone tokens
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

/* --------- Signature parsing (generation/tier) --------- */
type Tier = "base" | "plus" | "pro" | "promax" | "e" | null;

function parseIphoneSignature(text: string | null) {
  if (!text) return { gen: null as number|null, tier: null as Tier, storage: null as number|null, color: null as string|null };
  const s = text.toUpperCase();

  // generation
  const g = s.match(/\b(1[0-9]|[6-9])\b/); // crude: finds "16" etc.
  const gen = g ? parseInt(g[1], 10) : null;

  // tier detection (order matters)
  let tier: Tier = null;
  if (/\bPRO\s*MAX\b/.test(s)) tier = "promax";
  else if (/\bPRO\b/.test(s)) tier = "pro";
  else if (/\bPLUS\b/.test(s)) tier = "plus";
  else if (/\bIPHONE\s*E\b|\b\se\b/.test(s) || /\b16E\b/.test(s)) tier = "e";
  else tier = "base";

  // storage
  const sm = s.match(/(\d{2,4})\s*GB\b/);
  const storage = sm ? parseInt(sm[1], 10) : null;

  // color (lightweight)
  const cm = s.match(/\b(BLACK|WHITE|BLUE|PINK|PURPLE|GOLD|DESERT|TITANIUM|NATURAL|GREEN|RED|YELLOW|SILVER|MIDNIGHT|STARLIGHT)\b/);
  const color = cm ? cm[1].charAt(0) + cm[1].slice(1).toLowerCase() : null;

  return { gen, tier, storage, color };
}

function parseCarrier(obj: Record<string, any>): string | null {
  const preferred = ["carrier","network","locked carrier","original carrier","sold by","sold to","activation policy","sim"];
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
    { key: "unlocked", label: "Unlocked" }
  ];
  const entries = Object.entries(obj || {});
  for (const [k,v] of entries) {
    const kk = String(k).toLowerCase();
    const vv = String(v ?? "").toLowerCase();
    if (kk.includes("sim") && kk.includes("lock") && vv.includes("unlock")) return "Unlocked";
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

  // signature combines MD + display
  const sig = parseIphoneSignature([modelDesc, display].filter(Boolean).join(" "));

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
  };
}

/* --------- Price matching with strict model/tier --------- */
function isWatchOrAirpodsSheet(sheetName?: string) {
  if (!sheetName) return false;
  const s = sheetName.toLowerCase();
  return s.includes("watch") || s.includes("airpod") || s.includes("airpods");
}
function sheetPreference(isUnlocked: boolean) {
  return isUnlocked
    ? [/iphone.*unlock/i]          // unlocked → only unlocked sheets
    : [/^iphone(?!.*unlock)/i];    // locked → iphone sheets without "unlock"
}

function parseRowSignature(rowDevice: string) {
  // Parse the same signature from a prices.csv device string
  const sig = parseIphoneSignature(rowDevice);
  return sig;
}

function scoreMatchStrict(target: ReturnType<typeof parseIphoneSignature>, cand: ReturnType<typeof parseIphoneSignature>) {
  // hard requirements: same generation & tier
  if (target.gen && cand.gen && target.gen !== cand.gen) return -Infinity;
  if (target.tier && cand.tier && target.tier !== cand.tier) return -Infinity;

  // soft boosts
  let score = 0.5;
  if (target.storage && cand.storage && target.storage === cand.storage) score += 0.35;
  return score;
}
function scoreMatchRelaxed(target: ReturnType<typeof parseIphoneSignature>, cand: ReturnType<typeof parseIphoneSignature>, nameScore: number) {
  // relaxed: require same generation; allow tier mismatch but penalize
  if (target.gen && cand.gen && target.gen !== cand.gen) return -Infinity;
  let score = 0.3 * nameScore;
  if (target.tier && cand.tier && target.tier === cand.tier) score += 0.2;
  if (target.storage && cand.storage && target.storage === cand.storage) score += 0.2;
  return score;
}

function bestPriceMatchSmart(devName: string, isUnlocked: boolean, targetSig: ReturnType<typeof parseIphoneSignature>, priceRows: Record<string,string>[]) {
  // Filter sheets by lock state and exclude watch/airpods
  const preferred = sheetPreference(isUnlocked);
  const eligible = priceRows.filter(r => {
    const sheet = (r.sheet || "");
    if (isWatchOrAirpodsSheet(sheet)) return false;
    return preferred.some(re => re.test(sheet));
  });

  const candidates = eligible.length ? eligible : priceRows.filter(r => !isWatchOrAirpodsSheet(r.sheet));

  const targetNorm = norm(devName);

  // Pass 1: strict (same gen + same tier)
  let best: Record<string,string> | null = null;
  let bestScore = -Infinity;

  for (const row of candidates) {
    const dev = (row["device"] || "");
    if (!dev) continue;
    const candSig = parseRowSignature(dev);
    const s = scoreMatchStrict(targetSig, candSig);
    if (s === -Infinity) continue;

    // minor name similarity term
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

  // Pass 2: relaxed (same gen, tier optional) — still never watch/airpods
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

  // Nothing plausible
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
    const imeis: string[] = Array.isArray(body?.imeis) ? body.imeis : [];
    if (!imeis.length) {
      return new Response(JSON.stringify({ error: "Provide { imeis: [...] }" }), { status: 400, headers: { ...cors, "content-type":"application/json" }});
    }
    const capped = imeis.slice(0, 200).map(s => String(s).trim()).filter(Boolean);

    // prices.csv once
    const pricesResp = await fetch(PRICES_CSV_URL, { headers: { "accept": "text/csv" }});
    if (!pricesResp.ok) throw new Error(`prices.csv HTTP ${pricesResp.status}`);
    const csvText = await pricesResp.text();
    const priceRows = parseCSV(csvText);

    const items: any[] = [];
    for (const imei of capped) {
      try {
        const dev = await sickwFetch(env, imei);
        const isUnlocked = (dev.carrier || "").toLowerCase() === "unlocked";
        const pricing = bestPriceMatchSmart(
          dev.device_display,
          isUnlocked,
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
          confidence: pricing.confidence || 0
        });
      } catch (e: any) {
        items.push({ ok: false, imei, error: String(e?.message || e) });
      }
      await new Promise(r => setTimeout(r, 160));
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
