
export interface Env {}

const PRICES_CSV_URL = "https://allenslists.pages.dev/data/prices.csv";

/* ---------- CSV parser (robust for quotes) ---------- */
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

/* ---------- fuzzy scoring helpers ---------- */
function norm(s: string) {
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
function lev(a: string, b: string) {
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

function scoreDevice(query: string, device: string, sheet: string) {
  const q = norm(query);
  const d = norm(device);
  if (!q) return 0;
  let score = 0;

  // starts-with boost
  if (d.startsWith(q)) score += 0.45;

  // substring boost
  if (d.includes(q)) score += 0.35;

  // token coverage
  const tokens = q.split(" ");
  const hit = tokens.filter(t => t && d.includes(t)).length;
  if (tokens.length) score += 0.25 * (hit / tokens.length);

  // levenshtein similarity fallback
  const L = Math.max(d.length, q.length) || 1;
  const dist = lev(d, q);
  const sim = 1 - Math.min(1, dist / L);
  score += 0.2 * sim;

  // Sheet keyword hints
  const qq = " " + q + " ";
  if (/\bused\b/.test(qq) && /used/i.test(sheet)) score += 0.2;
  if (/\bunlocked?\b/.test(qq) && /unlock/i.test(sheet)) score += 0.15;
  if (/\block(ed)?\b/.test(qq) && /lock/i.test(sheet)) score += 0.1;
  if (/\bairpods?\b/.test(qq) && /airpod/i.test(sheet)) score += 0.25;
  if (/\bwatch(es)?\b/.test(qq) && /watch/i.test(sheet)) score += 0.2;

  return score;
}

/* ---------- handler ---------- */
export const onRequestGet: PagesFunction<Env> = async ({ request }) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };

  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "15", 10) || 15));

    if (!q || q.length < 2) {
      return new Response(JSON.stringify({ results: [] }), { headers: { ...cors, "content-type": "application/json" }});
    }

    const pricesResp = await fetch(PRICES_CSV_URL, { headers: { "accept": "text/csv" }});
    if (!pricesResp.ok) throw new Error(`prices.csv HTTP ${pricesResp.status}`);
    const csvText = await pricesResp.text();
    const rows = parseCSV(csvText);

    const scored = rows.map(r => {
      const device = r["device"] || "";
      const sheet  = r["sheet"] || "";
      const cents  = parseInt(r["purchase_price_cents"] || "0", 10) || 0;
      const score  = scoreDevice(q, device, sheet);
      return { device, sheet, purchase_price_cents: cents, price_dollars: Math.round(cents / 100), score };
    }).filter(x => x.device);

    scored.sort((a,b) => b.score - a.score);
    const results = scored.slice(0, limit);

    return new Response(JSON.stringify({ results }), { headers: { ...cors, "content-type": "application/json" }});
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { ...cors, "content-type": "application/json" }});
  }
};

export const onRequestOptions: PagesFunction = async () =>
  new Response("", { headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  }});
