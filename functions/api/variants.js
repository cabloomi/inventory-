export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const q = url.searchParams.get('q') || '';
    const storage = url.searchParams.get('storage') || '';
    const brand = url.searchParams.get('brand') || '';
    if (!q) return json({ error: 'Missing q' }, 400);
    const csv = await fetchCsv('https://allenslists.pages.dev/data/prices.csv');
    const prices = getVariantsFor({ q, storage, brand, csv });
    return json({ prices });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function fetchCsv(url) {
  const resp = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!resp.ok) throw new Error('Failed to fetch prices.csv');
  const text = await resp.text();
  const rows = parseCSV(text);
  const header = rows.shift() || [];
  const idx = makeIndex(header);
  return { rows, header, idx };
}

function getField(r, idx, name) {
  const i = idx[name];
  return (i != null) ? r[i] : '';
}

function getVariantsFor({ q, storage, brand, csv }) {
  const { rows, idx } = csv;
  const qNorm = normalize(q);
  const storageNorm = normalize(storage);

  const groups = { NEW_UNLOCKED: [], NEW_LOCKED: [], USED_UNLOCKED: [], USED_LOCKED: [] };

  for (const r of rows) {
    const sheet = getField(r, idx, 'sheet') || getField(r, idx, 'Sheet') || '';
    const device = getField(r, idx, 'device') || getField(r, idx, 'Device') || '';
    const pc = getField(r, idx, 'price_cents') || getField(r, idx, 'price') || '';
    const price_cents = toCents(pc);

    const devNorm = normalize(device);
    const sheetNorm = normalize(sheet);

    if (brand) {
      if (brand === 'apple' && !sheetNorm.includes('iphone') && !devNorm.includes('iphone')) continue;
      if (brand === 'samsung' && !sheetNorm.includes('samsung') && !devNorm.includes('samsung')) continue;
    }

    if (storageNorm && !devNorm.includes(storageNorm)) continue;

    const score = scoreMatch(qNorm, devNorm);
    if (score <= 0) continue;

    const key = sheetKey(sheetNorm);
    if (!key) continue;

    groups[key].push({ device, sheet, price_cents, score });
  }

  function bestOf(arr) {
    return arr.sort((a,b)=> b.score - a.score || a.price_cents - b.price_cents)[0];
  }

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

function toCents(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val > 10000 ? Math.round(val) : Math.round(val * 100);
  const n = Number(String(val).replace(/[^0-9.]/g, ''));
  if (!isNaN(n)) return n > 10000 ? Math.round(n) : Math.round(n * 100);
  return 0;
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sheetKey(sheetNorm) {
  const isIphone = sheetNorm.includes('iphone');
  const isSamsung = sheetNorm.includes('samsung');
  const isUsed = sheetNorm.includes('used');
  const isUnlocked = sheetNorm.includes('unlocked');
  const isLocked = sheetNorm.includes('locked') && !isUnlocked;
  if (!(isIphone || isSamsung)) return null;
  if (isUsed && isUnlocked) return 'USED_UNLOCKED';
  if (isUsed && isLocked) return 'USED_LOCKED';
  if (!isUsed && isUnlocked) return 'NEW_UNLOCKED';
  if (!isUsed && isLocked) return 'NEW_LOCKED';
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
  let i = 0, field = '', row = [], inQuotes = false;
  function pushField(){ row.push(field); field=''; }
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
  header.forEach((h,i)=>{ map[(h||'').toString().trim().toLowerCase()] = i; });
  return {
    sheet: map['sheet'],
    Sheet: map['sheet'],
    device: map['device'],
    Device: map['device'],
    price_cents: map['price_cents'] != null ? map['price_cents'] : map['price'],
    price: map['price_cents'] != null ? map['price_cents'] : map['price']
  };
}
