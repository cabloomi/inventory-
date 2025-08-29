/**
 * Optimized string utilities (TypeScript version)
 * - Faster string operations
 * - Consistent implementation across the codebase
 * - Better handling of edge cases
 */

/**
 * Normalize text for comparison (lowercase, trim, normalize spaces)
 * @param {string} s - String to normalize
 * @returns {string} Normalized string
 */
export function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize text for search with more aggressive cleaning
 * @param {string} s - String to normalize
 * @returns {string} Normalized string for search
 */
export function normalizeForSearch(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace non-alphanumeric with spaces
    .replace(/\s+/g, ' ')     // Normalize spaces
    .trim();
}

/**
 * Optimized Levenshtein distance calculation with early termination
 * @param {string} a - First string
 * @param {string} b - Second string
 * @param {number} [maxDistance] - Optional max distance for early termination
 * @returns {number} Edit distance between strings
 */
export function levenshtein(a: string, b: string, maxDistance: number = Infinity): number {
  // Handle edge cases efficiently
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  
  // Quick check for common prefix/suffix to reduce computation
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  
  let end = 0;
  while (
    end < a.length - start && 
    end < b.length - start && 
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  
  // Extract the middle part that needs calculation
  const aMiddle = a.slice(start, a.length - end);
  const bMiddle = b.slice(start, b.length - end);
  
  // If one string is empty after trimming common parts
  if (!aMiddle.length) return bMiddle.length;
  if (!bMiddle.length) return aMiddle.length;
  
  // Use smaller matrix to save memory
  const m = aMiddle.length;
  const n = bMiddle.length;
  
  // Early termination if difference in lengths exceeds maxDistance
  if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
  
  // Initialize first row
  let prevRow: number[] = Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;
  
  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    let currentRow = [i];
    let minDistance = Infinity;
    
    for (let j = 1; j <= n; j++) {
      const cost = aMiddle[i - 1] === bMiddle[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        prevRow[j] + 1,          // deletion
        currentRow[j - 1] + 1,   // insertion
        prevRow[j - 1] + cost    // substitution
      );
      minDistance = Math.min(minDistance, currentRow[j]);
    }
    
    // Early termination if we can't get below maxDistance
    if (minDistance > maxDistance) return maxDistance + 1;
    
    prevRow = currentRow;
  }
  
  // Add back the common prefix/suffix length
  return prevRow[n] + start + end;
}

/**
 * Calculate normalized similarity score between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score between 0 and 1
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  
  const distance = levenshtein(a, b);
  return 1 - distance / maxLen;
}

/**
 * Escape string for use in regular expressions
 * @param {string} s - String to escape
 * @returns {string} Escaped string safe for RegExp
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert string to title case with special handling for common words
 * @param {string} str - String to convert
 * @returns {string} Title cased string
 */
export function titleCase(str: string): string {
  if (!str) return '';
  
  // Special cases for product names
  const specialCases: Record<string, string> = {
    'iphone': 'iPhone',
    'ipad': 'iPad',
    'ipod': 'iPod',
    'macbook': 'MacBook',
    'imac': 'iMac',
    'airpods': 'AirPods',
    'pro max': 'Pro Max',
    'pro': 'Pro',
    'plus': 'Plus',
    'mini': 'Mini',
    'air': 'Air',
    'watch': 'Watch',
    'galaxy': 'Galaxy',
    'note': 'Note',
    'tab': 'Tab',
    'fold': 'Fold',
    'flip': 'Flip',
    'ultra': 'Ultra'
  };
  
  // First do standard title case
  let result = String(str).toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  
  // Then apply special cases
  Object.entries(specialCases).forEach(([key, value]) => {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    result = result.replace(regex, value);
  });
  
  return result;
}

/**
 * Extract tokens from a string for better matching
 * @param {string} s - String to tokenize
 * @returns {string[]} Array of tokens
 */
export function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  return normalizeForSearch(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Check if all tokens from needle are in haystack
 * @param {string} needle - String to find
 * @param {string} haystack - String to search in
 * @returns {boolean} True if all tokens are found
 */
export function containsAllTokens(needle: string, haystack: string): boolean {
  const needleTokens = tokenize(needle);
  const haystackNorm = normalizeForSearch(haystack);
  
  return needleTokens.every(token => haystackNorm.includes(token));
}