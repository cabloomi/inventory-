/**
 * API Balance Check - Optimized version
 * - Improved error handling
 * - Added caching
 * - Better response formatting
 */

export interface Env {
  SICKW_KEY?: string;
}

/**
 * Handle GET requests to check API balance
 */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };

  try {
    // Get API key from environment or return error
    const apiKey = env.SICKW_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ 
        error: "API key not configured" 
      }), { 
        status: 500, 
        headers: { ...cors, "content-type": "application/json" }
      });
    }

    // Build API URL
    const url = `https://sickw.com/api.php?action=balance&key=${encodeURIComponent(apiKey)}`;
    
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
      const response = await fetch(url, { 
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
          ...cors, 
          "content-type": "application/json",
          "cache-control": "max-age=60" // Cache for 1 minute
        }
      });
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error('API request timed out');
      }
      throw e;
    }
  } catch (e: any) {
    console.error('Balance API error:', e);
    
    return new Response(JSON.stringify({ 
      error: e.message || "Failed to check balance",
      timestamp: new Date().toISOString()
    }), { 
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