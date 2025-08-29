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

/* ---------------- Sickw parsing ---------------- */
function parseModelDescription(desc: string | null) {
  // Example: "IPHONE 16 PRO DESERT 256GB-USA"
  if (!desc) return { deviceName: null, color: null, storageGb: null };
  const raw = desc.toUpperCase().replace(/[^A-Z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  // strip trailing region suffixes like -USA
  const cleaned = raw.replace(/-?[A-Z]{2,3}\s*$/, "").trim();

  // storage
  const storageMatch = cleaned.match(/(\d{2,4})\s*GB\b/);
  const storageGb = storageMatch ? `${storageMatch[1]}GB` : null;

  // known iPhone tokens
  const model = cleaned
    .replace(/\bAPPLE\b/g, "")
    .replace(/\bINC\b/g, "")
    .replace(/\b\(A\d+\)\b/g, "")
    .replace(/\bUSA\b/g, "")
    .trim();

  // colors dictionary (extend as you see them)
  const COLORS = ["BLACK", "WHITE", "BLUE", "PINK", "PURPLE", "GOLD", "DESERT", "TITANIUM", "NATURAL", "GREEN", "RED", "YELLOW", "SILVER", "MIDNIGHT", "STARLIGHT"];
  let color: string | null = null;
  for (const c of COLORS) {
    const re = new RegExp(`\\b${c}\\b`, "i");
    if (re.test(model)) { color = c.charAt(0) + c.slice(1).toLowerCase(); break; }
  }

  // build device name from iPhone tokens
  // e.g., IPHONE 16 PRO MAX ... → "iPhone 16 Pro Max"
  let deviceTokens = model.split(/\s+/);
  const iPhoneIdx = deviceTokens.indexOf("IPHONE");
  let deviceName: string | null = null;
  if (iPhoneIdx !== -1) {
    const next = deviceTokens.slice(iPhoneIdx, iPhoneIdx + 5); // IPHONE 16 PRO MAX
    // stop before color/storage if present
    const stopWords = new Set(["BLACK","WHITE","BLUE","PINK","PURPLE","GOLD","DESERT","TITANIUM","NATURAL","GREEN","RED","YELLOW","SILVER","MIDNIGHT","STARLIGHT","GB","LTE","5G"]);
    const tokens: string[] = [];
    for (const t of next) {
      if (/^\d+GB$/.test(t)) break;
      if (stopWords.has(t)) break;
      tokens.push(t);
    }
    const pretty = tokens.map((t, idx) => idx === 0 ? "iPhone" : t.charAt(0) + t.slice(1).toLowerCase());
    deviceName = pretty.join(" ").replace(/\bPro\b\s+\bMax\b/i, "Pro Max");
  }

  return { deviceName, color, storageGb };
}

function parseCarrier(obj: Record<string, any>): string | null {
  const preferredKeys = ["carrier","network","locked carrier","original carrier","sold by","sold to","activation policy","sim"];
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
    // SIM-Lock unlocked ⇒ Unlocked
    if (kk.includes("sim") && kk.includes("lock") && vv.includes("unlock")) return "Unlocked";
  }
  for (const [k,v] of entries) {
    const kk = String(k).toLowerCase();
    const vv = String(v ?? "").toLowerCase();
    if (!preferredKeys.some(p => kk.includes(p))) continue;
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

  const carrier     = parseCarrier(res) || "Unknown";
  const icloudOn    = hasIcloudOn(res);

  return {
    imei: res.IMEI || j.imei || imei,
    manufacturer,
    model_code: modelCode,
    model_name: modelName,
    device_display: display,
    color: md.color,
    storage: md.storageGb, // string like "256GB"
    carrier,
    icloud_lock_on: icloudOn
  };
}

/* ---------------- Price matching with sheet preference ---------------- */
function sheetsForAppleIphone(isUnlocked: boolean): string[] {
  return isUnlocked ? ["iphone new unlocked"] : ["iphone"];
}
function isWatchOrAirpodsSheet(sheetName: string | undefined): boolean {
  if (!sheetName) return false;
  const s = sheetName.toLowerCase();
  return s.includes("watch") || s.includes("airpod") || s.includes("airpods");
}

function bestPriceMatchSmart(
  deviceDisplay: string,
  storage: string | null,
  carrier: string | null,
  isUnlocked: boolean,
  priceRows: Record<string,string>[]
) {
  const needle = norm(deviceDisplay);
  const preferredSheets = sheetsForAppleIphone(isUnlocked).map(s => s.toLowerCase());

  // filter rows: first pass only preferred sheets; second pass: any iPhone sheet; never watches/airpods
  const primary = priceRows.filter(r => preferredSheets.includes((r.sheet || "").toLowerCase()));
  const secondary = priceRows.filter(r => !isWatchOrAirpodsSheet(r.sheet));

  const searchSets = [primary, secondary];
  for (const set of searchSets) {
    let best: Record<string,string> | null = null;
    let bestScore = -Infinity;

    for (const row of set) {
      const dev = (row["device"] || "");
      if (!dev) continue;
      const hay = norm(dev);
      if (!hay || !needle) continue;

      // base string similarity
      let score = 0;
      if (hay.includes(needle) || needle.includes(hay)) score = 0.8;
      else {
        const len = Math.max(needle.length, hay.length);
        const d = lev(needle, hay);
        score = 0.8 * (1 - Math.min(1, d / Math.max(1, len)));
      }

      // storage boost
      if (storage) {
        const sNorm = storage.replace(/\s+/g, "").toLowerCase(); // "256gb"
        if (hay.includes(sNorm) || dev.toLowerCase().includes(sNorm)) score += 0.15;
      }

      // carrier boost
      if (carrier) {
        const c = carrier.toLowerCase();
        if (c === "unlocked" && (hay.includes("unlock") || hay.includes("unlocked"))) score += 0.05;
        if (c !== "unlocked" && hay.includes(c)) score += 0.05;
      }

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
        const pricing = bestPriceMatchSmart(
          dev.device_display,
          dev.storage,
          dev.carrier,
          dev.carrier.toLowerCase() === "unlocked",
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
          // base hidden on UI; kept here for debugging if needed
          base_price_cents: pricing.base_price_cents || null,
          // UI uses dollars and pre-fills "Price Paid ($)"
          suggested_price_cents: pricing.purchase_price_cents || null,
          suggested_price_dollars: pricing.purchase_price_dollars || null,
          confidence: pricing.confidence || 0
        });
      } catch (e: any) {
        items.push({ ok: false, imei, error: String(e?.message || e) });
      }
      await new Promise(r => setTimeout(r, 180));
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
