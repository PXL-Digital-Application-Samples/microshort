import express from 'express';
import { createHash } from 'crypto';

const app = express();
const PORT = process.env.PORT || 8080;
const URL_SERVICE_URL = process.env.URL_SERVICE_URL || 'http://url-service:3002';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';

const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';
const IP_HASH_SALT          = process.env.IP_HASH_SALT           || 'dev-ip-hash-salt-change-in-production';
const ANALYTICS_BATCH_SIZE  = parseInt(process.env.ANALYTICS_BATCH_SIZE  ?? '50');
const ANALYTICS_FLUSH_MS    = parseInt(process.env.ANALYTICS_FLUSH_MS    ?? '5000');

// Enable trust proxy so req.ip reflects the real client when behind a proxy (M4).
// In bare Compose without a proxy, req.ip is the Docker bridge gateway; the
// ip_hash mechanism is correct but all events will share the same hash.
app.set('trust proxy', 1);

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
    const response = await fetch(`${URL_SERVICE_URL}/urls/${slug}`, { signal: AbortSignal.timeout(2000) });
    
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

function hashIp(ip) {
  return createHash('sha256').update((ip || '0.0.0.0') + IP_HASH_SALT).digest('hex');
}

const eventBuffer = [];

function bufferEvent(slug, userAgent, referer, ip) {
  eventBuffer.push({
    slug,
    ts:        new Date().toISOString(),
    referrer:  referer    || '',
    userAgent: userAgent  || '',
    ipHash:    hashIp(ip)
  });
  if (eventBuffer.length >= ANALYTICS_BATCH_SIZE) flushEvents();
}

function flushEvents() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  fetch(`${ANALYTICS_SERVICE_URL}/events:batch`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': SERVICE_TOKEN },
    body:    JSON.stringify(batch),
    signal:  AbortSignal.timeout(5000)
  }).catch(err => console.error('Analytics flush failed:', err));
}

setInterval(flushEvents, ANALYTICS_FLUSH_MS);

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Home page (root domain)
app.get('/', async (req, res) => {
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, { signal: AbortSignal.timeout(2000) });
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
  bufferEvent(slug, req.headers['user-agent'], req.headers['referer'], req.ip);
  
  // Perform redirect
  res.set('Cache-Control', 'no-store');
  res.redirect(302, redirectUrl);
});

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
