/**
 * Search API - Optimized version
 * - Uses shared utility functions
 * - Improved search algorithm
 * - Better error handling and caching
 */

import { fetchCSV } from '../utils/csv.js';
import { normalize, stringSimilarity, tokenize } from '../utils/string.js';
import { jsonResponse, error, parseParams } from '../utils/api.js';
import { memoize } from '../utils/cache.js';

export interface Env {}

const PRICES_CSV_URL = "https://allenslists.pages.dev/data/prices.csv";

// Memoize the fetchCSV function to avoid redundant fetches
const memoizedFetchCSV = memoize(
  (url: string) => fetchCSV(url, { cache: { cacheTtl: 300 } }),
  (args) => args[0],
  300 // 5 minute cache
);

/**
 * Score a device match for search results
 */
function scoreDevice(query: string, device: string, sheet: string): number {
  const q = normalize(query);
  const d = normalize(device);
  if (!q) return 0;
  
  let score = 0;

  // Starts-with boost
  if (d.startsWith(q)) score += 0.45;

  // Substring boost
  if (d.includes(q)) score += 0.35;

  // Token coverage
  const tokens = q.split(" ");
  const hit = tokens.filter(t => t && d.includes(t)).length;
  if (tokens.length) score += 0.25 * (hit / tokens.length);

  // String similarity for fuzzy matching
  const sim = stringSimilarity(d, q);
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

/**
 * Handle GET requests for device search
 */
export const onRequestGet: PagesFunction<Env> = async ({ request }) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };

  try {
    // Parse and validate parameters
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "15", 10) || 15));

    // Return empty results for short queries
    if (!q || q.length < 2) {
      return new Response(JSON.stringify({ results: [] }), { 
        headers: { ...cors, "content-type": "application/json" }
      });
    }

    // Fetch CSV data with caching
    const { rows } = await memoizedFetchCSV(PRICES_CSV_URL);

    // Score and filter results
    const scored = rows.map(r => {
      const device = r["device"] || "";
      const sheet = r["sheet"] || "";
      const cents = parseInt(r["purchase_price_cents"] || "0", 10) || 0;
      const score = scoreDevice(q, device, sheet);
      
      return { 
        device, 
        sheet, 
        purchase_price_cents: cents, 
        price_dollars: Math.round(cents / 100), 
        score 
      };
    })
    .filter(x => x.device && x.score > 0); // Only include items with a score

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);
    
    // Return top results
    const results = scored.slice(0, limit);

    return new Response(JSON.stringify({ results }), { 
      headers: { ...cors, "content-type": "application/json" }
    });
  } catch (e: any) {
    console.error('Search API error:', e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { 
      status: 500, 
      headers: { ...cors, "content-type": "application/json" }
    });
  }
};

/**
 * Handle OPTIONS requests for CORS
 */
export const onRequestOptions: PagesFunction = async () =>
  new Response("", { 
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, OPTIONS"
    }
  });