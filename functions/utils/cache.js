/**
 * Cache utilities for improved performance
 * - Memory caching for frequently accessed data
 * - Optimized fetch with caching
 */

// Simple in-memory cache with expiration
const memoryCache = new Map();

/**
 * Get item from cache
 * @param {string} key - Cache key
 * @returns {any|null} Cached value or null if not found/expired
 */
export function getCachedItem(key) {
  if (!key) return null;
  
  const item = memoryCache.get(key);
  if (!item) return null;
  
  // Check if expired
  if (item.expiry && item.expiry < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  
  return item.value;
}

/**
 * Set item in cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttlSeconds - Time to live in seconds
 */
export function setCachedItem(key, value, ttlSeconds = 300) {
  if (!key) return;
  
  const expiry = ttlSeconds > 0 ? Date.now() + (ttlSeconds * 1000) : null;
  memoryCache.set(key, { value, expiry });
}

/**
 * Clear cache item
 * @param {string} key - Cache key to clear
 */
export function clearCachedItem(key) {
  if (key) memoryCache.delete(key);
}

/**
 * Clear all cache
 */
export function clearCache() {
  memoryCache.clear();
}

/**
 * Fetch with caching
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} cacheTtl - Cache TTL in seconds
 * @returns {Promise<Response>} Fetch response
 */
export async function cachedFetch(url, options = {}, cacheTtl = 300) {
  // Generate cache key from URL and relevant options
  const cacheKey = `fetch:${url}:${JSON.stringify(options.headers || {})}`;
  
  // Try to get from cache first
  const cached = getCachedItem(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Not in cache, perform actual fetch
  const response = await fetch(url, {
    ...options,
    cf: { ...(options.cf || {}), cacheTtl }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
  }
  
  // Clone response before consuming it
  const clonedResponse = response.clone();
  
  // Get response data based on content type
  const contentType = response.headers.get('content-type') || '';
  let data;
  
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else if (contentType.includes('text/')) {
    data = await response.text();
  } else {
    data = await response.arrayBuffer();
  }
  
  // Cache the data
  setCachedItem(cacheKey, data, cacheTtl);
  
  // Return the cloned response
  return clonedResponse;
}

/**
 * Memoize a function (cache results based on arguments)
 * @param {Function} fn - Function to memoize
 * @param {Function} keyFn - Function to generate cache key from arguments
 * @param {number} ttlSeconds - Cache TTL in seconds
 * @returns {Function} Memoized function
 */
export function memoize(fn, keyFn = JSON.stringify, ttlSeconds = 300) {
  return function(...args) {
    const key = `memo:${fn.name}:${keyFn(args)}`;
    
    const cached = getCachedItem(key);
    if (cached !== null) {
      return cached;
    }
    
    const result = fn.apply(this, args);
    
    // Handle promises
    if (result instanceof Promise) {
      return result.then(value => {
        setCachedItem(key, value, ttlSeconds);
        return value;
      });
    }
    
    setCachedItem(key, result, ttlSeconds);
    return result;
  };
}

/**
 * Batch process items with controlled concurrency
 * @param {Array} items - Items to process
 * @param {Function} processFn - Function to process each item
 * @param {Object} options - Batch processing options
 * @returns {Promise<Array>} Results array
 */
export async function batchProcess(items, processFn, options = {}) {
  const {
    concurrency = 5,
    delayMs = 200,
    onProgress = null
  } = options;
  
  const results = [];
  const queue = [...items];
  const activePromises = new Set();
  
  while (queue.length > 0 || activePromises.size > 0) {
    // Fill up to concurrency limit
    while (activePromises.size < concurrency && queue.length > 0) {
      const item = queue.shift();
      
      const promise = (async () => {
        try {
          // Add delay if specified
          if (delayMs > 0 && activePromises.size > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          
          const result = await processFn(item);
          results.push(result);
          
          // Report progress if callback provided
          if (onProgress) {
            const progress = results.length / items.length;
            onProgress(progress, results.length, items.length);
          }
          
          return result;
        } catch (error) {
          // Add error result
          results.push({ error, item });
          return { error, item };
        } finally {
          activePromises.delete(promise);
        }
      })();
      
      activePromises.add(promise);
    }
    
    // Wait for at least one promise to complete if we've hit the limit
    if (activePromises.size >= concurrency) {
      await Promise.race(activePromises);
    }
  }
  
  return results;
}