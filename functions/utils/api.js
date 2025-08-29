/**
 * API utilities for consistent response handling and error management
 */

/**
 * Create a JSON response with proper headers
 * @param {Object} data - Response data
 * @param {number} status - HTTP status code
 * @param {Object} options - Additional options
 * @returns {Response} Formatted Response object
 */
export function jsonResponse(data, status = 200, options = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': options.cache || 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    ...options.headers
  };
  
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Create a success response
 * @param {Object} data - Response data
 * @param {number} status - HTTP status code (default: 200)
 * @returns {Response} Success response
 */
export function success(data, status = 200) {
  return jsonResponse(data, status);
}

/**
 * Create an error response
 * @param {string|Error} error - Error message or object
 * @param {number} status - HTTP status code (default: 500)
 * @returns {Response} Error response
 */
export function error(error, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message }, status);
}

/**
 * Handle API requests with automatic error handling
 * @param {Function} handler - Request handler function
 * @returns {Function} Wrapped handler with error handling
 */
export function createApiHandler(handler) {
  return async (context) => {
    try {
      return await handler(context);
    } catch (e) {
      console.error('API Error:', e);
      return error(e);
    }
  };
}

/**
 * Parse request parameters with validation
 * @param {Request} request - Request object
 * @param {Object} schema - Parameter schema with defaults and validation
 * @returns {Object} Parsed and validated parameters
 */
export async function parseParams(request, schema = {}) {
  const url = new URL(request.url);
  const params = {};
  
  // Process query parameters
  for (const [key, config] of Object.entries(schema)) {
    const value = url.searchParams.get(key);
    
    if (value === null || value === undefined) {
      if (config.required) {
        throw new Error(`Missing required parameter: ${key}`);
      }
      params[key] = config.default;
      continue;
    }
    
    // Type conversion
    if (config.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(`Invalid number for parameter: ${key}`);
      }
      params[key] = num;
    } else if (config.type === 'boolean') {
      params[key] = ['true', '1', 'yes'].includes(value.toLowerCase());
    } else {
      params[key] = value;
    }
    
    // Validation
    if (config.validate && !config.validate(params[key])) {
      throw new Error(`Invalid value for parameter: ${key}`);
    }
  }
  
  // Handle JSON body if present
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const body = await request.json().catch(() => ({}));
        Object.assign(params, body);
      }
    } catch (e) {
      console.error('Error parsing request body:', e);
    }
  }
  
  return params;
}

/**
 * Create CORS preflight response
 * @returns {Response} CORS preflight response
 */
export function corsResponse() {
  return new Response('', {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400'
    }
  });
}

/**
 * Handle API request with rate limiting
 * @param {Object} context - Request context
 * @param {Function} handler - Request handler
 * @param {Object} options - Rate limiting options
 * @returns {Promise<Response>} API response
 */
export async function handleWithRateLimit(context, handler, options = {}) {
  // Handle OPTIONS request for CORS
  if (context.request.method === 'OPTIONS') {
    return corsResponse();
  }
  
  // Get client IP for rate limiting
  const clientIP = context.request.headers.get('cf-connecting-ip') || 
                  context.request.headers.get('x-forwarded-for') || 
                  'unknown';
  
  // Rate limiting (if KV namespace is available)
  if (context.env && context.env.RATE_LIMITS) {
    const key = `ratelimit:${clientIP}:${options.endpoint || 'api'}`;
    const limit = options.limit || 60; // requests per minute
    const window = options.window || 60; // seconds
    
    try {
      const current = await context.env.RATE_LIMITS.get(key, 'json') || { count: 0, timestamp: Date.now() };
      
      // Reset counter if window has passed
      if (Date.now() - current.timestamp > window * 1000) {
        current.count = 0;
        current.timestamp = Date.now();
      }
      
      // Increment counter
      current.count++;
      
      // Update KV
      await context.env.RATE_LIMITS.put(key, JSON.stringify(current), { expirationTtl: window });
      
      // Check if limit exceeded
      if (current.count > limit) {
        return jsonResponse({ 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((current.timestamp + window * 1000 - Date.now()) / 1000)
        }, 429, {
          headers: {
            'retry-after': Math.ceil((current.timestamp + window * 1000 - Date.now()) / 1000)
          }
        });
      }
    } catch (e) {
      // If rate limiting fails, log and continue
      console.error('Rate limiting error:', e);
    }
  }
  
  // Process the request
  try {
    return await handler(context);
  } catch (e) {
    console.error('API Error:', e);
    return error(e);
  }
}