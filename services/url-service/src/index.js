import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createUrl, getUrlBySlug, getUserUrls, deleteUrl, updateClickCount, getAllUrls, getUrlStats, pool, checkHealth } from './db.js';
import { nanoid } from 'nanoid';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import promClient from 'prom-client';
import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const servicePrefix = 'microshort_url_';
promClient.collectDefaultMetrics({ prefix: servicePrefix });

// HTTP request counter
const httpRequests = new promClient.Counter({
  name: `${servicePrefix}http_requests_total`,
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status']
});

// HTTP request duration histogram
const httpDuration = new promClient.Histogram({
  name: `${servicePrefix}http_request_duration_seconds`,
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
});

// Custom metric: URL creation counter
const urlCreations = new promClient.Counter({
  name: 'microshort_url_creations_total',
  help: 'Short URLs created',
  labelNames: ['type']    // 'auto' (nanoid), 'custom' (user-specified slug)
});

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000
});

redis.on('error', err => logger.error({ err }, 'Redis error'));

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
const CONFIG_SERVICE_URL = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:3005';
const SERVICE_TOKEN         = process.env.SERVICE_TOKEN          || '';
const CLICK_SYNC_INTERVAL_MS = parseInt(process.env.CLICK_SYNC_INTERVAL_MS ?? '60000');

// Enable trust proxy for rate limiting if behind a reverse proxy
app.set('trust proxy', 1);

app.use(pinoHttp({
  logger,
  genReqId: req => req.headers['x-request-id'] ?? randomUUID(),
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: { ignore: req => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' }
}));

app.use((req, res, next) => {
  res.setHeader('X-Request-ID', req.id);
  next();
});

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (['/health', '/ready', '/metrics'].includes(req.path)) return next();

  const end = httpDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    const route = req.route?.path ?? 'unknown';
    end({ route });
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

// Rate limiter for URL creation
const urlCreateLimiter = rateLimit({
  windowMs: parseInt(process.env.URL_RATE_LIMIT_WINDOW_MS ?? String(60 * 1000)),
  limit:    parseInt(process.env.URL_RATE_LIMIT_MAX ?? '30'),
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-url:'
  }),
  message: { error: 'Too many requests, please try again later' }
});

// Cache for domain config
let cachedDomain = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

// Get domain from config service
async function getDomain(reqId) {
  if (cachedDomain && Date.now() - cacheTime < CACHE_TTL) {
    return cachedDomain;
  }
  
  try {
    const headers = {};
    if (reqId) {
      headers['x-request-id'] = reqId;
    }
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
      headers,
      signal: AbortSignal.timeout(2000)
    });
    const data = await response.json();
    cachedDomain = data.domain;
    cacheTime = Date.now();
    return cachedDomain;
  } catch (err) {
    logger.error({ err }, 'Failed to get domain');
    throw new Error('Configuration service unavailable');
  }
}

// Validate API key middleware
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': req.id
      },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const data = await response.json();
    req.user = { id: data.userId, role: data.role };
    next();
  } catch (err) {
    req.log.error({ err }, 'Auth validation error');
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

// Health check (liveness)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Readiness check
app.get('/ready', async (req, res) => {
  const ok = await checkHealth();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Create short URL
app.post('/urls', urlCreateLimiter, validateApiKey, async (req, res) => {
  try {
    const { url, customSlug } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }
    
    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    // Generate or validate slug
    let slug = customSlug;
    if (!slug) {
      slug = nanoid(6); // 6 character random slug
    } else {
      // Validate custom slug
      if (!/^[a-zA-Z0-9_-]+$/.test(slug) || slug.length > 50) {
        return res.status(400).json({ error: 'Invalid slug format' });
      }
    }
    
    // Check if slug already exists
    const existing = await getUrlBySlug(slug);
    if (existing) {
      return res.status(409).json({ error: 'Slug already in use' });
    }
    
    // Create URL
    const urlRecord = await createUrl(req.user.id, url, slug);
    const domain = await getDomain(req.id);
    
    urlCreations.inc({ type: customSlug ? 'custom' : 'auto' });

    res.status(201).json({
      id: urlRecord.id,
      shortUrl: `${domain}/${slug}`,
      longUrl: url,
      slug: slug,
      createdAt: urlRecord.created_at
    });
  } catch (err) {
    req.log.error({ err }, 'Create URL error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get URL by slug (public endpoint for redirect service)
app.get('/urls/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const urlRecord = await getUrlBySlug(slug);
    
    if (!urlRecord) {
      return res.status(404).json({ error: 'URL not found' });
    }
    
    res.json({
      longUrl: urlRecord.long_url,
      slug: urlRecord.slug
    });
  } catch (err) {
    req.log.error({ err }, 'Get URL error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List user's URLs
app.get('/urls', validateApiKey, async (req, res) => {
  try {
    const urls = await getUserUrls(req.user.id);
    const domain = await getDomain(req.id);
    
    const formattedUrls = urls.map(u => ({
      id: u.id,
      shortUrl: `${domain}/${u.slug}`,
      longUrl: u.long_url,
      slug: u.slug,
      clicks: u.clicks,
      createdAt: u.created_at
    }));
    
    res.json({ urls: formattedUrls });
  } catch (err) {
    req.log.error({ err }, 'List URLs error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete URL
app.delete('/urls/:slug', validateApiKey, async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Check ownership
    const urlRecord = await getUrlBySlug(slug);
    if (!urlRecord) {
      return res.status(404).json({ error: 'URL not found' });
    }
    
    if (urlRecord.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    await deleteUrl(urlRecord.id);
    res.json({ message: 'URL deleted', slug });
  } catch (err) {
    req.log.error({ err }, 'Delete URL error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get all URLs
app.get('/admin/urls', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Validate admin key via auth service
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': req.id
      },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(2000)
    });

    if (!authResponse.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const authData = await authResponse.json();
    if (!authData.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const urls = await getAllUrls();
    const domain = await getDomain(req.id);
    
    const formattedUrls = urls.map(u => ({
      id: u.id,
      shortUrl: `${domain}/${u.slug}`,
      longUrl: u.long_url,
      slug: u.slug,
      clicks: u.clicks,
      userId: u.user_id,
      createdAt: u.created_at
    }));
    
    res.json({ urls: formattedUrls });
  } catch (err) {
    req.log.error({ err }, 'Admin URLs error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get URL stats
app.get('/admin/stats', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Validate admin key
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': req.id
      },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(2000)
    });

    if (!authResponse.ok) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const authData = await authResponse.json();
    if (!authData.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await getUrlStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Admin stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function syncClickCounts() {
  const jobId = randomUUID();
  logger.info({ job: 'click-sync', jobId }, 'Starting click count sync');
  try {
    const [rows] = await pool.execute('SELECT slug FROM urls');
    if (rows.length === 0) {
      logger.info({ job: 'click-sync', jobId }, 'No slugs to sync');
      return;
    }

    const slugs = rows.map(r => r.slug).join(',');
    const res = await fetch(
      `${ANALYTICS_SERVICE_URL}/stats/counts?slugs=${encodeURIComponent(slugs)}`,
      {
        headers: {
          'X-Service-Token': SERVICE_TOKEN,
          'x-request-id': jobId
        },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (!res.ok) {
      logger.warn({ job: 'click-sync', jobId, status: res.status }, 'Analytics stats counts returned non-OK response');
      return;
    }

    const counts = await res.json(); // { slug: count, ... }
    await Promise.all(
      Object.entries(counts).map(([slug, count]) => updateClickCount(slug, count))
    );
    logger.info({ job: 'click-sync', jobId }, 'Click sync complete');
  } catch (err) {
    logger.error({ job: 'click-sync', jobId, err }, 'Click count sync failed');
  }
}

const syncIntervalId = setInterval(syncClickCounts, CLICK_SYNC_INTERVAL_MS);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'URL service started');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close(async () => {
    try {
      clearInterval(syncIntervalId);
      logger.info('Sync interval cleared');
    } catch (err) {
      logger.error({ err }, 'Error clearing sync interval');
    }
    try {
      await pool.end();
      logger.info('MySQL connection pool closed');
    } catch (err) {
      logger.error({ err }, 'Error closing MySQL connection pool');
    }
    try {
      await redis.quit();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.error({ err }, 'Error closing Redis connection');
    }
    logger.info('URL service shut down cleanly');
    process.exit(0);
  });

  // Force-quit if graceful drain takes > 30 s
  setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));