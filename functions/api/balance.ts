/**
 * API Balance Check - Optimized version
 * - Improved error handling
 * - Added caching
 * - Better response formatting
 */

export interface Env {
  SICKW_KEY?: string;
  SICKW_API_KEY?: string; // Support both key formats
}

/**
 * Handle GET requests to check API balance
 */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  // Set CORS headers for all responses
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  };

  try {
    // Validate API key (support both key formats)
    const apiKey = env.SICKW_KEY || env.SICKW_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { ...headers, 'content-type': 'application/json' }
      });
    }

    // Fetch balance with timeout and error handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
      // Build API URL
      const url = new URL("https://sickw.com/api.php");
      url.searchParams.set("action", "balance");
      url.searchParams.set("key", apiKey);
      
      const response = await fetch(url.toString(), { 
        signal: controller.signal,
        cf: { cacheTtl: 60 } // Cache for 1 minute
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      
      const balance = await response.text();
      
      return new Response(JSON.stringify({ 
        balance: balance.trim(),
        timestamp: new Date().toISOString()
      }), {
        headers: { 
          ...headers, 
          'content-type': 'application/json',
          'cache-control': 'max-age=60' // Cache for 1 minute
        }
      });
    } catch (e: any) {
      clearTimeout(timeoutId);
      
      // Handle specific fetch errors
      if (e.name === 'AbortError') {
        return new Response(JSON.stringify({ error: 'Request timed out' }), {
          status: 504,
          headers: { ...headers, 'content-type': 'application/json' }
        });
      }
      
      throw e;
    }
  } catch (e: any) {
    console.error('Balance API error:', e);
    
    return new Response(JSON.stringify({ 
      error: `Failed to check balance: ${e.message || 'Unknown error'}`,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { ...headers, 'content-type': 'application/json' }
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