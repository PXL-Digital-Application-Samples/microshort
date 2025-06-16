import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;
const URL_SERVICE_URL = process.env.URL_SERVICE_URL || 'http://url-service:3002';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

// Simple in-memory cache for performance
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutes
const MAX_CACHE_SIZE = 10000; // Prevent memory issues

// Get URL from cache or url-service
async function getRedirectUrl(slug) {
  // Check cache first
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.url;
  }

  try {
    // Fetch from url-service
    const response = await fetch(`${URL_SERVICE_URL}/urls/${slug}`);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    
    // Cache the result
    if (cache.size >= MAX_CACHE_SIZE) {
      // Simple LRU: remove oldest entries
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    
    cache.set(slug, {
      url: data.longUrl,
      timestamp: Date.now()
    });
    
    return data.longUrl;
  } catch (err) {
    console.error('Error fetching URL:', err);
    return null;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Home page (root domain)
app.get('/', async (req, res) => {
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`);
    const config = await response.json();
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>microshort</title>
        <style>
          body { font-family: system-ui; text-align: center; padding: 50px; }
          h1 { color: #333; }
          p { color: #666; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>microshort</h1>
        <p>URL shortener service</p>
        <p>Domain: <code>${config.domain}</code></p>
      </body>
      </html>
    `);
  } catch (err) {
    res.send('<h1>microshort</h1><p>URL shortener service</p>');
  }
});

// Handle redirects
app.get('/:slug', async (req, res) => {
  const { slug } = req.params;
  
  // Validate slug format
  if (!slug || slug.length > 50) {
    return res.status(404).send('Not found');
  }
  
  // Get redirect URL
  const redirectUrl = await getRedirectUrl(slug);
  
  if (!redirectUrl) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>404 - Not Found</title>
        <style>
          body { font-family: system-ui; text-align: center; padding: 50px; }
          h1 { color: #e74c3c; }
          p { color: #666; }
        </style>
      </head>
      <body>
        <h1>404</h1>
        <p>Short URL not found</p>
      </body>
      </html>
    `);
  }
  
  // Log the redirect (async, don't wait)
  logRedirect(slug, req.headers['user-agent'], req.headers['referer']).catch(err => 
    console.error('Failed to log redirect:', err)
  );
  
  // Perform redirect
  res.redirect(301, redirectUrl);
});

// Log redirect for analytics (placeholder for now)
async function logRedirect(slug, userAgent, referer) {
  // In the future, this would send to analytics-service
  console.log(`Redirect: ${slug} | UA: ${userAgent?.substring(0, 50)} | Ref: ${referer || 'direct'}`);
}

// Clear expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [slug, data] of cache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      cache.delete(slug);
    }
  }
}, 60000); // Every minute

app.listen(PORT, () => {
  console.log(`Redirect service running on port ${PORT}`);
});
