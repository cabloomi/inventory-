/**
 * Device variants API - Optimized version
 * - Uses shared utility functions
 * - Improved error handling
 * - Better caching
 */

import { fetchCSV } from '../utils/csv.js';
import { getPricingVariants } from '../utils/device-matcher.js';
import { jsonResponse, error } from '../utils/api.js';
import { cachedFetch, memoize } from '../utils/cache.js';

// Memoize the fetchCSV function to avoid redundant fetches
const memoizedFetchCSV = memoize(
  (url) => fetchCSV(url, { cache: { cacheTtl: 300 } }),
  (args) => args[0],
  300 // 5 minute cache
);

/**
 * Handle GET requests to fetch device variants
 */
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const q = url.searchParams.get('q') || '';
    const storage = url.searchParams.get('storage') || '';
    const brand = url.searchParams.get('brand') || '';
    
    // Validate required parameters
    if (!q) {
      return error('Missing required parameter: q', 400);
    }
    
    // Fetch CSV data with caching
    const csv = await memoizedFetchCSV('https://allenslists.pages.dev/data/prices.csv');
    
    // Get pricing variants
    const prices = getPricingVariants(q, storage, brand, csv.rows);
    
    // Return success response
    return jsonResponse({ prices });
  } catch (e) {
    console.error('Variants API error:', e);
    return error(e);
  }
}

/**
 * Handle OPTIONS requests for CORS
 */
export function onRequestOptions() {
  return new Response('', {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, OPTIONS'
    }
  });
}