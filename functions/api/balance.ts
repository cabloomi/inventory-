/**
 * API Balance Check - Fixed version
 * - Improved error handling
 * - Better response formatting
 * - Added caching
 */

export interface Env { 
  SICKW_API_KEY: string; 
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
    // Validate API key
    const apiKey = env.SICKW_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { ...headers, 'content-type': 'application/json' }
      });
    }

    // Fetch balance with timeout and error handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    try {
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
        headers: { ...headers, 'content-type': 'application/json' }
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      
      // Handle specific fetch errors
      if (fetchError.name === 'AbortError') {
        return new Response(JSON.stringify({ error: 'Request timed out' }), {
          status: 504,
          headers: { ...headers, 'content-type': 'application/json' }
        });
      }
      
      throw fetchError;
    }
  } catch (e: any) {
    console.error('Balance API error:', e);
    
    return new Response(JSON.stringify({ 
      error: `Failed to check balance: ${e.message || 'Unknown error'}` 
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
  new Response('', {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, OPTIONS'
    }
  });