/**
 * Optimized device matching utilities
 * - Improved matching algorithms
 * - Better handling of device variants
 * - More accurate pricing suggestions
 */

import { normalize, levenshtein, tokenize, containsAllTokens } from './string.js';

/**
 * Score a match between a query and device name
 * @param {string} query - Search query
 * @param {string} deviceName - Device name to match against
 * @returns {number} Match score (higher is better)
 */
export function scoreMatch(query, deviceName) {
  if (!query || !deviceName) return 0;
  
  const q = normalize(query);
  const dev = normalize(deviceName);
  
  let score = 0;
  
  // Exact match bonus
  if (q === dev) return 10;
  
  // Contains as substring bonus
  if (dev.includes(q)) score += 3;
  if (q.includes(dev)) score += 2;
  
  // Token matching (more precise than substring)
  const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  const devTokens = dev.split(/[^a-z0-9]+/).filter(Boolean);
  
  // Count matching tokens
  let matchingTokens = 0;
  for (const token of qTokens) {
    if (token.length < 2) continue; // Skip very short tokens
    
    if (devTokens.includes(token)) {
      matchingTokens++;
      // Longer token matches are more significant
      score += token.length >= 3 ? 2 : 1;
    }
  }
  
  // All tokens found bonus
  if (matchingTokens === qTokens.length && qTokens.length > 0) {
    score += 3;
  }
  
  // Levenshtein distance for fuzzy matching (only if basic matching failed)
  if (score === 0) {
    const maxLen = Math.max(q.length, dev.length);
    if (maxLen > 0) {
      const distance = levenshtein(q, dev);
      const similarity = 1 - (distance / maxLen);
      
      // Only consider if similarity is reasonable
      if (similarity > 0.7) {
        score += similarity * 2;
      }
    }
  }
  
  return score;
}

/**
 * Determine the sheet key based on device condition and carrier
 * @param {string} sheetName - Sheet name to analyze
 * @returns {string|null} Sheet key or null if not recognized
 */
export function determineSheetKey(sheetName) {
  if (!sheetName) return null;
  
  const sheet = normalize(sheetName);
  
  // Check for device type
  const isIphone = sheet.includes('iphone');
  const isSamsung = sheet.includes('samsung');
  const isWatch = sheet.includes('watch');
  const isAirpods = sheet.includes('airpod');
  
  // Skip non-phone sheets
  if (isWatch || isAirpods) return null;
  if (!(isIphone || isSamsung)) return null;
  
  // Check for condition
  const isUsed = sheet.includes('used');
  
  // Check for carrier status
  const isUnlocked = sheet.includes('unlocked');
  const isLocked = sheet.includes('locked') && !isUnlocked;
  
  // Determine key
  if (isUsed && isUnlocked) return 'USED_UNLOCKED';
  if (isUsed && isLocked) return 'USED_LOCKED';
  if (!isUsed && isUnlocked) return 'NEW_UNLOCKED';
  if (!isUsed && isLocked) return 'NEW_LOCKED';
  
  // Default cases based on sheet content
  if (isUsed) return 'USED_UNLOCKED'; // Default to unlocked for used
  return 'NEW_UNLOCKED'; // Default to new unlocked
}

/**
 * Infer brand from device name
 * @param {string} deviceName - Device name
 * @returns {string} Brand name ('apple', 'samsung', or 'other')
 */
export function inferBrand(deviceName) {
  const name = normalize(deviceName);
  
  if (name.includes('iphone') || name.includes('apple')) return 'apple';
  if (name.includes('samsung') || name.includes('galaxy')) return 'samsung';
  
  return 'other';
}

/**
 * Find best matching device from price rows
 * @param {string} deviceName - Device name to match
 * @param {string|null} storage - Storage size (e.g., '128GB')
 * @param {string} carrier - Carrier name
 * @param {boolean} isUsed - Whether device is used
 * @param {Array<Object>} priceRows - Array of price data rows
 * @returns {Object} Best match with price information
 */
export function findBestDeviceMatch(deviceName, storage, carrier, isUsed, priceRows) {
  if (!deviceName || !priceRows || !priceRows.length) {
    return { match: null, confidence: 0, purchase_price_cents: 0 };
  }
  
  const brand = inferBrand(deviceName);
  const isUnlocked = normalize(carrier) === 'unlocked';
  
  // Filter rows by relevant sheet type
  const sheetType = isUsed 
    ? (isUnlocked ? 'USED_UNLOCKED' : 'USED_LOCKED')
    : (isUnlocked ? 'NEW_UNLOCKED' : 'NEW_LOCKED');
  
  // First pass: filter by brand and sheet type
  const candidates = priceRows.filter(row => {
    const rowSheet = row.sheet || '';
    const rowDevice = row.device || '';
    
    // Skip irrelevant brands
    if (brand === 'apple' && !normalize(rowSheet).includes('iphone')) return false;
    if (brand === 'samsung' && !normalize(rowSheet).includes('samsung')) return false;
    
    // Check sheet type
    const key = determineSheetKey(rowSheet);
    if (key !== sheetType) return false;
    
    // If storage is specified, filter by that too
    if (storage && !normalize(rowDevice).includes(normalize(storage))) return false;
    
    return true;
  });
  
  if (!candidates.length) return { match: null, confidence: 0, purchase_price_cents: 0 };
  
  // Second pass: score matches
  const scored = candidates.map(row => {
    const score = scoreMatch(deviceName, row.device || '');
    return { row, score };
  });
  
  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);
  
  // Get best match
  const best = scored[0];
  if (!best || best.score <= 0) {
    return { match: null, confidence: 0, purchase_price_cents: 0 };
  }
  
  const purchase_price_cents = parseInt(best.row.purchase_price_cents || '0', 10) || 0;
  const base_price_cents = parseInt(best.row.base_price_cents || '0', 10) || 0;
  
  // Normalize confidence to 0-1 range
  const confidence = Math.min(1, best.score / 10);
  
  return {
    match: best.row,
    confidence: parseFloat(confidence.toFixed(3)),
    purchase_price_cents,
    base_price_cents
  };
}

/**
 * Get pricing variants for a device
 * @param {string} deviceName - Device name
 * @param {string|null} storage - Storage size
 * @param {string} brand - Device brand
 * @param {Array<Object>} priceRows - Array of price data rows
 * @returns {Object} Pricing variants for different conditions
 */
export function getPricingVariants(deviceName, storage, brand, priceRows) {
  const variants = {
    NEW_UNLOCKED: null,
    NEW_LOCKED: null,
    USED_UNLOCKED: null,
    USED_LOCKED: null
  };
  
  // Find best match for each variant
  const newUnlocked = findBestDeviceMatch(deviceName, storage, 'Unlocked', false, priceRows);
  const newLocked = findBestDeviceMatch(deviceName, storage, 'Locked', false, priceRows);
  const usedUnlocked = findBestDeviceMatch(deviceName, storage, 'Unlocked', true, priceRows);
  const usedLocked = findBestDeviceMatch(deviceName, storage, 'Locked', true, priceRows);
  
  // Set prices for each variant
  if (newUnlocked.match) variants.NEW_UNLOCKED = newUnlocked.purchase_price_cents;
  if (newLocked.match) variants.NEW_LOCKED = newLocked.purchase_price_cents;
  if (usedUnlocked.match) variants.USED_UNLOCKED = usedUnlocked.purchase_price_cents;
  if (usedLocked.match) variants.USED_LOCKED = usedLocked.purchase_price_cents;
  
  // Find best overall match for metadata
  const matches = [newUnlocked, newLocked, usedUnlocked, usedLocked]
    .filter(m => m.match)
    .sort((a, b) => b.confidence - a.confidence);
  
  if (matches.length > 0) {
    const best = matches[0];
    variants.match_device = best.match.device;
    variants.match_sheet = best.match.sheet;
    variants.confidence = best.confidence;
  }
  
  return variants;
}

/**
 * Extract storage capacity from device description
 * @param {string} description - Device description
 * @returns {string|null} Storage capacity or null if not found
 */
export function extractStorage(description) {
  if (!description) return null;
  
  const match = description.match(/\b(\d{1,4})\s*(?:GB|TB)\b/i);
  if (!match) return null;
  
  return match[0].replace(/\s+/g, '');
}

/**
 * Extract color from device description using known color list
 * @param {string} description - Device description
 * @param {Array<string>} colorList - List of known colors
 * @returns {string|null} Color name or null if not found
 */
export function extractColor(description, colorList) {
  if (!description || !colorList || !colorList.length) return null;
  
  const upper = ' ' + description.toUpperCase() + ' ';
  
  for (const color of colorList) {
    const pattern = new RegExp(`[^A-Z0-9]${color.toUpperCase()}[^A-Z0-9]`);
    if (pattern.test(upper)) return color;
  }
  
  return null;
}

/**
 * Generate a variant key based on condition and carrier
 * @param {string} condition - Device condition ('New' or 'Used')
 * @param {string} carrier - Device carrier ('Unlocked' or other)
 * @returns {string} Variant key (e.g., 'NEW_UNLOCKED')
 */
export function variantKey(condition, carrier) {
  const lock = (carrier === 'Unlocked') ? 'UNLOCKED' : 'LOCKED';
  return (condition || 'New').toUpperCase() + '_' + lock;
}