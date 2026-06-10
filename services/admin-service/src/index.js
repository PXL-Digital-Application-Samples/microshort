import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import promClient from 'prom-client';
import { env } from './env.js';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = pino({ level: env.LOG_LEVEL });

const servicePrefix = 'microshort_admin_';
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

const app = express();
const PORT = env.PORT;
const AUTH_SERVICE_URL = env.AUTH_SERVICE_URL;
const URL_SERVICE_URL = env.URL_SERVICE_URL;
const CONFIG_SERVICE_URL = env.CONFIG_SERVICE_URL;
const ANALYTICS_SERVICE_URL = env.ANALYTICS_SERVICE_URL;
const SERVICE_TOKEN         = env.SERVICE_TOKEN;
const ADMIN_SERVICE_TOKEN   = env.ADMIN_SERVICE_TOKEN || SERVICE_TOKEN;

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

const allowedOrigins = env.ALLOWED_ORIGINS === '*'
  ? '*'
  : env.ALLOWED_ORIGINS.split(',').map(o => o.trim());

app.use(cors({ origin: allowedOrigins }));
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

// Validate admin API key middleware
async function validateAdminKey(req, res, next) {
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

    // Check pre-computed isAdmin property from auth-service
    if (!data.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.admin = { id: data.userId, role: data.role };
    next();
  } catch (err) {
    req.log.error({ err }, 'Admin auth validation error');
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Liveness check
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Service is alive
 */
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Readiness check
 *     tags: [Observability]
 *     responses:
 *       200:
 *         description: Service is ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ready
 */
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Short-lived in-process dashboard cache to absorb thundering herd
const DASHBOARD_CACHE_TTL = 10_000; // 10 seconds
let dashboardCache = null;
let dashboardCacheExpiry = 0;

// Fetch an upstream service, returning null (not throwing) on any failure
async function fetchUpstream(url, options, log) {
  try {
    const res = await fetch(url, { ...options });
    if (!res.ok) {
      log.warn({ url, status: res.status }, 'Upstream returned non-OK response');
      return null;
    }
    return res.json();
  } catch (err) {
    log.warn({ url, err: err.message }, 'Upstream fetch failed');
    return null;
  }
}

/**
 * @openapi
 * /admin/dashboard:
 *   get:
 *     summary: Get dashboard overview (aggregated from all services)
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Dashboard data. Partial responses are returned when upstream services are degraded.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 degraded:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Names of services that could not be reached
 *                 users:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     total:
 *                       type: integer
 *                     recentSignups:
 *                       type: integer
 *                     totalApiKeys:
 *                       type: integer
 *                 urls:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       nullable: true
 *                     recentUrls:
 *                       type: integer
 *                       nullable: true
 *                     totalClicks:
 *                       type: integer
 *                       nullable: true
 *                     topUrls:
 *                       type: array
 *                       nullable: true
 *                       items:
 *                         type: object
 *                         properties:
 *                           slug:
 *                             type: string
 *                           clicks:
 *                             type: integer
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/dashboard', validateAdminKey, async (req, res) => {
  // Serve cached response if still fresh
  if (dashboardCache && Date.now() < dashboardCacheExpiry) {
    req.log.debug('Serving cached dashboard response');
    return res.json(dashboardCache);
  }

  const sharedHeaders = { 'x-request-id': req.id };

  const [authData, urlData, overviewData, topData] = await Promise.all([
    fetchUpstream(`${AUTH_SERVICE_URL}/internal/admin/stats`, {
      headers: { 'X-Service-Token': ADMIN_SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${URL_SERVICE_URL}/internal/admin/stats`, {
      headers: { 'X-Service-Token': ADMIN_SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${ANALYTICS_SERVICE_URL}/stats/overview`, {
      headers: { 'X-Service-Token': ADMIN_SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${ANALYTICS_SERVICE_URL}/stats/top?limit=10`, {
      headers: { 'X-Service-Token': ADMIN_SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log)
  ]);

  const degraded = [
    authData     === null && 'auth',
    urlData      === null && 'url',
    overviewData === null && 'analytics'
  ].filter(Boolean);

  const response = {
    ...(degraded.length > 0 && { degraded }),
    users: authData ? {
      total:         authData.totalUsers,
      recentSignups: authData.recentUsers,
      totalApiKeys:  authData.totalApiKeys
    } : null,
    urls: {
      total:       urlData?.totalUrls        ?? null,
      recentUrls:  urlData?.recentUrls       ?? null,
      totalClicks: overviewData?.totalClicks ?? null,
      topUrls:     topData?.map(t => ({ slug: t.slug, clicks: t.totalClicks })) ?? null
    }
  };

  // Update cache
  dashboardCache    = response;
  dashboardCacheExpiry = Date.now() + DASHBOARD_CACHE_TTL;

  if (degraded.length > 0) {
    req.log.warn({ degraded }, 'Dashboard response is partial');
  }

  res.json(response);
});

/**
 * @openapi
 * /admin/users:
 *   get:
 *     summary: List all users
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Paginated user list (proxied from auth-service)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                 nextCursor:
 *                   type: integer
 *                   nullable: true
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/users', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/admin/users`, {
      headers: { 'X-API-Key': req.headers['x-api-key'], 'x-request-id': req.id },
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      throw new Error('Failed to fetch users');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Users list error');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * @openapi
 * /admin/urls:
 *   get:
 *     summary: List all short URLs
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Paginated URL list (proxied from url-service)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 urls:
 *                   type: array
 *                   items:
 *                     type: object
 *                 nextCursor:
 *                   type: integer
 *                   nullable: true
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/urls', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${URL_SERVICE_URL}/admin/urls`, {
      headers: {
        'X-Service-Token': ADMIN_SERVICE_TOKEN,
        'x-request-id': req.id
      },
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      throw new Error('Failed to fetch URLs');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'URLs list error');
    res.status(500).json({ error: 'Failed to fetch URLs' });
  }
});

/**
 * @openapi
 * /admin/urls/{slug}:
 *   put:
 *     summary: Update the long URL for a slug
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: URL updated
 *       400:
 *         description: URL missing or invalid
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 *       404:
 *         description: Slug not found
 */
app.put('/admin/urls/:slug', validateAdminKey, async (req, res) => {
  try {
    const { slug } = req.params;
    const { url } = req.body;

    const response = await fetch(`${URL_SERVICE_URL}/urls/${slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': ADMIN_SERVICE_TOKEN,
        'x-request-id': req.id
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errData.error || 'Failed to update URL' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Update URL error');
    res.status(500).json({ error: 'Failed to update URL' });
  }
});

/**
 * @openapi
 * /admin/users/{userId}:
 *   get:
 *     summary: Get a user by ID (not yet implemented)
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       501:
 *         description: Not implemented
 */
app.get('/admin/users/:userId', validateAdminKey, async (req, res) => {
  res.status(501).json({
    error: 'Not implemented',
    note: 'User-detail view requires new endpoints in auth-service and url-service. '
        + 'Tracked for M7.'
  });
});

/**
 * @openapi
 * /admin/config:
 *   put:
 *     summary: Update the short URL domain (ephemeral — resets on restart)
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain]
 *             properties:
 *               domain:
 *                 type: string
 *                 example: https://sho.rt
 *     responses:
 *       200:
 *         description: Domain updated (persists only until config-service restarts)
 *       400:
 *         description: Domain missing
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.put('/admin/config', validateAdminKey, async (req, res) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: 'Domain required' });
    }

    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': env.CONFIG_WRITE_TOKEN,
        'x-request-id': req.id
      },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      throw new Error('Failed to update config');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Config update error');
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

/**
 * @openapi
 * /admin/config:
 *   get:
 *     summary: Get the current domain configuration
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Current configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 domain:
 *                   type: string
 *                   example: https://sho.rt
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/config', validateAdminKey, async (req, res) => {
  try {
    const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
      headers: { 'x-request-id': req.id },
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      throw new Error('Failed to fetch config');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Config fetch error');
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

/**
 * @openapi
 * /admin/search/urls:
 *   get:
 *     summary: Search short URLs by slug or long URL substring
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query
 *     responses:
 *       200:
 *         description: Matching URLs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 urls:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Search query missing
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/search/urls', validateAdminKey, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const response = await fetch(
      `${URL_SERVICE_URL}/admin/urls?q=${encodeURIComponent(q)}`,
      {
        headers: { 'X-API-Key': req.headers['x-api-key'], 'x-request-id': req.id },
        signal: AbortSignal.timeout(2000)
      }
    );

    if (!response.ok) {
      throw new Error('Failed to search URLs');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * @openapi
 * /admin/health/services:
 *   get:
 *     summary: Check health of all downstream services
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Health status of each service
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 services:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       service:
 *                         type: string
 *                         example: auth
 *                       status:
 *                         type: string
 *                         enum: [healthy, unhealthy, unreachable]
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/health/services', validateAdminKey, async (req, res) => {
  try {
    const services = [
      { name: 'auth',      url: `${AUTH_SERVICE_URL}/health` },
      { name: 'url',       url: `${URL_SERVICE_URL}/health` },
      { name: 'config',    url: `${CONFIG_SERVICE_URL}/health` },
      { name: 'analytics', url: `${ANALYTICS_SERVICE_URL}/actuator/health/liveness` }
    ];

    const healthChecks = await Promise.all(
      services.map(async (service) => {
        try {
          const response = await fetch(service.url, {
            headers: { 'x-request-id': req.id },
            signal: AbortSignal.timeout(2000)
          });
          return {
            service: service.name,
            status: response.ok ? 'healthy' : 'unhealthy',
            responseTime: response.headers.get('x-response-time') || 'N/A'
          };
        } catch (err) {
          return {
            service: service.name,
            status: 'unreachable',
            error: err.message
          };
        }
      })
    );

    res.json({ services: healthChecks });
  } catch (err) {
    req.log.error({ err }, 'Health check error');
    res.status(500).json({ error: 'Health check failed' });
  }
});

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Admin Service API',
      version: '1.0.0',
      description: 'Aggregation API for the microshort admin dashboard. All endpoints require an admin API key.'
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      }
    }
  },
  apis: [join(__dirname, 'index.js')]
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Admin service started');
  });
}

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  if (server) {
    server.close(() => {
      logger.info('Admin service shut down cleanly');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
};

if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

export function __resetDashboardCache() {
  dashboardCache = null;
  dashboardCacheExpiry = 0;
}

export { app, server };
