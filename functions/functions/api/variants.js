export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const storage = (url.searchParams.get("storage") || "").trim();
    const brand = (url.searchParams.get("brand") || "").trim();

    if (!q) return json({ error: "Missing q" }, 400);

    const csvText = await fetchCsv("https://allenslists.pages.dev/data/prices.csv");
    const rows = parseCsv(csvText);

    const prices = getVariantsFor({ q, storage, brand, rows });
    return json({ prices });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/** ---------- helpers ---------- **/

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function fetchCsv(url) {
  const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

/** very small CSV parser (no quotes-with-commas edge cases) */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(","); // assumes simple CSV
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (cols[i] ?? "").trim()));
    return normalizeRow(obj);
  });
}

function normalizeRow(row) {
  // add convenience/normalized fields without destroying original columns
  const out = { ...row };

  // brand/model fallbacks
  out.brand = row.brand || inferBrand(row.model || row["Model"] || "");
  out.model = row.model || row["Model"] || "";

  // storage normalization (e.g., "128GB" -> "128")
  const storRaw =
    row.storage ||
    row["Storage"] ||
    row["storage_gb"] ||
    row["Capacity"] ||
    "";
  const storMatch = String(storRaw).match(/\d{2,4}/);
  out.storage_gb = storMatch ? Number(storMatch[0]) : null;

  // condition, lock state (various header spellings)
  out.condition = (row.condition || row.Condition || "").toUpperCase();
  out.lock_state = (row.lock_state || row.lock || row["Carrier Lock"] || "").toUpperCase();

  // price normalization (prefer cents if present)
  const pc = toNumber(row.price_cents ?? row.price_cent ?? "");
  const p = toNumber(row.price ?? row.Price ?? "");
  out.price_cents =
    Number.isFinite(pc) && pc > 0
      ? Math.round(pc)
      : Number.isFinite(p) && p > 0
      ? Math.round(p * 100)
      : null;

  // helpful slugs for filtering
  out._slug = slug(out.brand + " " + out.model);
  out._lock = slug(out.lock_state);
  out._cond = slug(out.condition);

  return out;
}

function toNumber(x) {
  if (x == null) return NaN;
  const n = Number(String(x).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function inferBrand(model) {
  const m = model.toLowerCase();
  if (/iphone|ipad|ipod|mac|apple/i.test(model)) return "Apple";
  if (m.includes("galaxy") || m.includes("samsung")) return "Samsung";
  if (m.includes("pixel") || m.includes("google")) return "Google";
  return "";
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Main filter: fuzzy model match on q, optional storage/brand narrowing,
 * and return a compact payload your UI can use.
 */
function getVariantsFor({ q, storage, brand, rows }) {
  const qSlug = slug(q);

  const storageNum = storage ? Number(String(storage).match(/\d{2,4}/)?.[0]) : null;
  const brandSlug = slug(brand);

  const filtered = rows.filter((r) => {
    if (!r._slug.includes(qSlug)) return false;
    if (storageNum && r.storage_gb && r.storage_gb !== storageNum) return false;
    if (brandSlug && slug(r.brand) !== brandSlug) return false;
    return true;
  });

  // Sort: prefer exact storage, then Unlocked over Locked, then USED over NEW (you can tweak)
  filtered.sort((a, b) => {
    const storScore = (r) => (storageNum && r.storage_gb === storageNum ? 0 : 1);
    const lockScore = (r) => (r._lock.includes("unlock") ? 0 : 1);
    const condScore = (r) => (r._cond.includes("used") ? 0 : 1);
    return (
      storScore(a) - storScore(b) ||
      lockScore(a) - lockScore(b) ||
      condScore(a) - condScore(b) ||
      (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity)
    );
  });

  // Keep original columns, but project a friendly shape commonly used by your intake UI
  return filtered.map((r) => ({
    brand: r.brand,
    model: r.model,
    storage_gb: r.storage_gb,
    condition: r.condition, // "USED" | "NEW" (varies by CSV)
    lock_state: r.lock_state, // "UNLOCKED" | "LOCKED" (varies by CSV)
    price_cents: r.price_cents, // normalized
    // keep a full copy in case the UI needs less-common columns
    row: r,
  }));
}
