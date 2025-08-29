export interface Env {
  SICKW_API_KEY: string;
  SICKW_SERVICE_ID?: string; // default "6"
}

const PRICES_CSV_URL = "https://allenslists.pages.dev/data/prices.csv";

// Tiny CSV → JSON parser (supports quoted fields, commas, newlines in quotes)
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
  // last field/row
  pushField();
  if (row.length > 1 || row[0] !== "") pushRow();

  const header = rows.shift() || [];
  return rows.map(r => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => obj[h.trim().toLowerCase()] = (r[idx] ?? "").trim());
    return obj;
  });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function lev(a: string, b: string): number {
  // Levenshtein distance
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i)=> Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0] = i;
  for (let j=0;j<=n;j++) dp[0][j] = j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

function bestPriceMatch(deviceDisplay: string, priceRows: Record<string,string>[]) {
  const needle = norm(deviceDisplay);
  let best: Record<string,string> | null = null;
  let bestScore = -Infinity;

  for (const row of priceRows) {
    const dev = (row["device"] || "");
    if (!dev) continue;
    const hay = norm(dev);
    if (!hay || !needle) continue;

    let score = 0;
    if (hay.includes(needle) || needle.includes(hay)) {
      score = 1;
    } else {
      const len = Math.max(needle.length, hay.length);
      const d = lev(needle, hay);
      score = 1 - Math.min(1, d / Math.max(1, len));
    }
    if (score > bestScore) { bestScore = score; best = row; }
  }

  if (!best) return { match: null, confidence: 0 };
  const purchase = parseInt(best["purchase_price_cents"] || "0", 10) || 0;
  const base = parseInt(best["base_price_cents"] || "0", 10) || 0;
  return {
    match: best,
    confidence: Math.round(bestScore * 1000) / 1000,
    purchase_price_cents: purchase,
    base_price_cents: base
  };
}

async function sickwFetch(env: Env, imei: string) {
  const url = new URL("https://sickw.com/api.php");
  url.searchParams.set("format", "beta");
  url.searchParams.set("key", env.SICKW_API_KEY);
  url.searchParams.set("imei", imei);
  url.searchParams.set("service", env.SICKW_SERVICE_ID || "6");

  const r = await fetch(url.toString(), { headers: { "accept": "application/json" }});
  if (!r.ok) throw new Error(`Sickw HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== "success") {
    throw new Error(typeof j.result === "string" ? j.result : JSON.stringify(j));
  }
  const res = j.result || {};
  const manufacturer = res.Manufacturer || null;
  const modelCode   = res["Model Code"] || null;
  const modelName   = res["Model Name"] || null;
  const display = `${manufacturer ? manufacturer+" " : ""}${modelName || modelCode || ""}`.trim();
  return {
    imei: res.IMEI || j.imei || imei,
    manufacturer,
    model_code: modelCode,
    model_name: modelName,
    device_display: display
  };
}

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

    // fetch prices.csv once
    const pricesResp = await fetch(PRICES_CSV_URL, { headers: { "accept": "text/csv" }});
    if (!pricesResp.ok) throw new Error(`prices.csv HTTP ${pricesResp.status}`);
    const csvText = await pricesResp.text();
    const priceRows = parseCSV(csvText);

    const items: any[] = [];
    for (const imei of capped) {
      try {
        const dev = await sickwFetch(env, imei);
        const pricing = bestPriceMatch(dev.device_display, priceRows);
        items.push({
          ok: true,
          imei: dev.imei,
          manufacturer: dev.manufacturer,
          model_name: dev.model_name,
          model_code: dev.model_code,
          device_display: dev.device_display,
          match_device: pricing.match?.device || null,
          match_sheet: pricing.match?.sheet || null,
          base_price_cents: pricing.base_price_cents || null,
          suggested_price_cents: pricing.purchase_price_cents || null,
          confidence: pricing.confidence || 0
        });
      } catch (e: any) {
        items.push({ ok: false, imei, error: String(e?.message || e) });
      }
      // polite pacing
      await new Promise(r => setTimeout(r, 200));
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
