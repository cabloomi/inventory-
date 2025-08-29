/**
 * Optimized CSV parsing utilities
 */

/**
 * Parse CSV text into an array of objects with column headers as keys
 * @param {string} text - CSV text content
 * @returns {Array<Object>} - Array of objects with column headers as keys
 */
export function parseCSV(text) {
  // Handle BOM character if present
  const cleanText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  
  // Split into lines and handle different line endings
  const lines = cleanText.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  
  // Parse header row
  const header = parseCSVRow(lines[0]);
  const normalizedHeader = header.map(h => (h || '').toString().trim().toLowerCase());
  
  // Parse data rows
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    const row = parseCSVRow(lines[i]);
    const obj = {};
    
    normalizedHeader.forEach((key, idx) => {
      if (key) obj[key] = row[idx] || '';
    });
    
    result.push(obj);
  }
  
  return result;
}

/**
 * Parse a single CSV row, handling quoted fields correctly
 * @param {string} line - CSV line to parse
 * @returns {Array<string>} - Array of field values
 */
function parseCSVRow(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Handle escaped quotes
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(field);
        field = '';
      } else {
        field += char;
      }
    }
  }
  
  // Add the last field
  result.push(field);
  return result;
}

/**
 * Create an index map for quick column access
 * @param {Array<string>} header - CSV header row
 * @returns {Object} - Map of column names to indices
 */
export function makeIndex(header) {
  const map = {};
  header.forEach((h, i) => {
    const key = (h || '').toString().trim().toLowerCase();
    if (key) map[key] = i;
  });
  
  return {
    sheet: map['sheet'],
    device: map['device'],
    price_cents: map['price_cents'] != null ? map['price_cents'] : map['price'],
    price: map['price_cents'] != null ? map['price_cents'] : map['price'],
    base_price_cents: map['base_price_cents'],
    purchase_price_cents: map['purchase_price_cents']
  };
}

/**
 * Get a field value from a row using the index map
 * @param {Array<string>} row - CSV data row
 * @param {Object} idx - Index map
 * @param {string} name - Field name
 * @returns {string} - Field value
 */
export function getField(row, idx, name) {
  const i = idx[name.toLowerCase()];
  return (i != null) ? row[i] : '';
}

/**
 * Convert a value to cents, handling different formats
 * @param {any} val - Value to convert (number, string with $ or plain)
 * @returns {number} Value in cents
 */
export function toCents(val) {
  if (val == null) return 0;
  
  // Already a number
  if (typeof val === 'number') {
    return val > 10000 ? Math.round(val) : Math.round(val * 100);
  }
  
  // String conversion with better handling of currency symbols
  const cleaned = String(val).replace(/[$,]/g, '').trim();
  const n = parseFloat(cleaned);
  
  if (!isNaN(n)) {
    return n > 10000 ? Math.round(n) : Math.round(n * 100);
  }
  
  return 0;
}

/**
 * Normalize text for comparison (lowercase, trim, normalize spaces)
 * @param {string} s - String to normalize
 * @returns {string} Normalized string
 */
export function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fetch and parse CSV from a URL with caching
 * @param {string} url - URL to fetch CSV from
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} - Parsed CSV data
 */
export async function fetchCSV(url, options = {}) {
  const cacheOptions = options.cache || { cacheTtl: 300 };
  const resp = await fetch(url, { 
    cf: cacheOptions,
    headers: { "accept": "text/csv" }
  });
  
  if (!resp.ok) throw new Error(`Failed to fetch CSV: HTTP ${resp.status}`);
  
  const text = await resp.text();
  const data = parseCSV(text);
  const header = Object.keys(data[0] || {});
  const idx = makeIndex(header);
  
  return { rows: data, header, idx };
}