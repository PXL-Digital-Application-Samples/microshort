import express from 'express';
import { createHash, randomUUID } from 'crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';
import promClient from 'prom-client';
import Redis from 'ioredis';
import { env } from './env.js';

const logger = pino({ level: env.LOG_LEVEL });

const servicePrefix = 'microshort_redirect_';
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

// Cache hits and misses counters
const cacheHits = new promClient.Counter({
  name: 'microshort_redirect_cache_hits_total',
  help: 'Slug cache hits served from Redis'
});

const cacheMisses = new promClient.Counter({
  name: 'microshort_redirect_cache_misses_total',
  help: 'Slug cache misses (fetched from url-service)'
});

const CACHE_TTL_SECONDS = parseInt(env.CACHE_TTL_SECONDS);

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000
});

redis.on('error', err => logger.error({ err }, 'Redis error'));

const app = express();
const PORT = env.PORT;
const URL_SERVICE_URL = env.URL_SERVICE_URL;
const CONFIG_SERVICE_URL = env.CONFIG_SERVICE_URL;
const ANALYTICS_SERVICE_URL = env.ANALYTICS_SERVICE_URL;
const SERVICE_TOKEN         = env.SERVICE_TOKEN;
const IP_HASH_SALT          = env.IP_HASH_SALT;
const ANALYTICS_BATCH_SIZE  = parseInt(env.ANALYTICS_BATCH_SIZE);
const ANALYTICS_FLUSH_MS    = parseInt(env.ANALYTICS_FLUSH_MS);

// Enable trust proxy so req.ip reflects the real client when behind a proxy
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

// Get URL from cache or url-service
async function getRedirectUrl(slug, reqLog, reqId) {
  const key = `slug:${slug}`;

  // Try Redis cache
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      cacheHits.inc();
      reqLog.debug({ slug }, 'Cache hit (Redis)');
      return cached;
    }
  } catch (err) {
    reqLog.warn({ err }, 'Redis unavailable — falling through to url-service');
  }

  cacheMisses.inc();

  // Fetch from url-service
  try {
    const response = await fetch(`${URL_SERVICE_URL}/urls/${slug}`, {
      headers: {
        'x-request-id': reqId
      },
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return null;
    const data = await response.json();

    // Populate cache (best-effort; don't block redirect on failure)
    redis.set(key, data.longUrl, 'EX', CACHE_TTL_SECONDS).catch(
      err => reqLog.warn({ err }, 'Failed to write cache to Redis')
    );

    return data.longUrl;
  } catch (err) {
    reqLog.error({ err }, 'Error fetching URL from url-service');
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
  if (eventBuffer.length >= ANALYTICS_BATCH_SIZE) {
    flushEvents().catch(err => logger.error({ err }, 'Buffered analytics flush failed'));
  }
}

async function flushEvents() {
  if (eventBuffer.length === 0) return;
  const jobId = randomUUID();
  const batch = eventBuffer.splice(0);
  logger.info({ job: 'analytics-flush', jobId, batchSize: batch.length }, 'Flushing analytics events');
  try {
    await fetch(`${ANALYTICS_SERVICE_URL}/events:batch`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': SERVICE_TOKEN,
        'x-request-id': jobId
      },
      body:    JSON.stringify(batch),
      signal:  AbortSignal.timeout(5000)
    });
    logger.info({ job: 'analytics-flush', jobId }, 'Flush complete');
  } catch (err) {
    logger.error({ job: 'analytics-flush', jobId, err }, 'Analytics flush failed');
  }
}

const flushIntervalId = setInterval(() => {
  flushEvents().catch(err => logger.error({ err }, 'Periodic analytics flush failed'));
}, ANALYTICS_FLUSH_MS);

// Health check (liveness)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Readiness check
app.get('/ready', (req, res) => {
  res.json({ status: 'ready' });
});

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Home page (root domain)
app.get('/', async (req, res) => {
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
      headers: {
        'x-request-id': req.id
      },
      signal: AbortSignal.timeout(2000)
    });
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
  const redirectUrl = await getRedirectUrl(slug, req.log, req.id);
  
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

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Redirect service started');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close(async () => {
    try {
      clearInterval(flushIntervalId);
      logger.info('Flush interval cleared');
    } catch (err) {
      logger.error({ err }, 'Error clearing flush interval');
    }
    try {
      await flushEvents();
      logger.info('Buffered events flushed');
    } catch (err) {
      logger.error({ err }, 'Error flushing buffered events on shutdown');
    }
    try {
      await redis.quit();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.error({ err }, 'Error closing Redis connection');
    }
    logger.info('Redirect service shut down cleanly');
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
