// server.ts
import express, { Request, Response } from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import promClient from 'prom-client';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import configSchema from '../config.schema.json';
import { cleanEnv, url, str } from 'envalid';

export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const servicePrefix = 'microshort_config_';
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
const env = cleanEnv(process.env, {
  DOMAIN:             url({ desc: 'Base URL for short links. Must be a valid URI.' }),
  CONFIG_WRITE_TOKEN: str({ desc: 'Token required to accept PUT /config/domain' }),
  PORT:               str({ default: '3000' }),
  LOG_LEVEL:          str({ default: 'info' }),
});

const ajv = new Ajv();
addFormats(ajv);

const schema = {
  ...configSchema,
  properties: {
    ...configSchema.properties,
    domain: {
      ...configSchema.properties.domain,
      ...((process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') && {
        pattern: '^https://'
      })
    }
  }
};
const validateConfig = ajv.compile(schema);

// In-memory config state. Seeded from env var at startup.
// PUT /config/domain mutates this at runtime (ephemeral — resets on restart).
let currentDomain = env.DOMAIN;

const PORT = env.PORT;
const isDev = process.env.NODE_ENV !== 'production';

app.use(pinoHttp({
  logger,
  genReqId: req => (req.headers['x-request-id'] as string) ?? randomUUID(),
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: { ignore: req => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' }
}));

app.use((req, res, next) => {
  res.setHeader('X-Request-ID', (req as any).id);
  next();
});

app.use(bodyParser.json());

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

/**
 * @openapi
 * /config/domain:
 *   get:
 *     summary: Get the configured short URL domain
 *     responses:
 *       200:
 *         description: The current domain
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 domain:
 *                   type: string
 */
app.get('/config/domain', (req: Request, res: Response): void => {
  res.json({ domain: currentDomain });
});

/**
 * @openapi
 * /config/domain:
 *   put:
 *     summary: Update the configured domain
 *     security:
 *       - serviceToken: []
 *     parameters:
 *       - in: header
 *         name: X-Service-Token
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               domain:
 *                 type: string
 *                 example: "https://sho.rt"
 *     responses:
 *       200:
 *         description: Domain updated successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
function safeTokenEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

app.put('/config/domain', (req: Request, res: Response): void => {
  const expected = env.CONFIG_WRITE_TOKEN;
  const token = (req.headers['x-service-token'] as string) ?? '';
  if (!expected || !safeTokenEqual(expected, token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { domain } = req.body;
  if (!validateConfig({ domain })) {
    res.status(400).json({ error: 'Validation failed', details: validateConfig.errors });
    return;
  }

  currentDomain = domain;
  (req as any).log.warn(
    { domain, note: 'ephemeral — will reset to DOMAIN env var on restart' },
    'Domain updated in-memory'
  );
  res.json({
    message: 'Domain updated',
    domain,
    warning: 'This change is ephemeral. Set DOMAIN env var to persist across restarts.'
  });
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Service is healthy
 */
app.get('/health', (_req: Request, res: Response): void => {
  res.status(200).send('OK');
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Readiness check endpoint
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service is unavailable
 */
app.get('/ready', (_req: Request, res: Response): void => {
  res.json({ status: 'ready', domain: currentDomain });
});

// Metrics check
app.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Swagger/OpenAPI configuration with dev/prod fallback
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Config Service API',
      version: '1.0.0',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: [
    path.join(__dirname, 'server.ts'),
    path.join(__dirname, 'server.js'),
  ],
});

// Assert that the Swagger spec has loaded endpoints successfully
if (!(swaggerSpec as any).paths || Object.keys((swaggerSpec as any).paths).length === 0) {
  logger.warn('Swagger specification paths are empty. API path configuration may be incorrect.');
}

// Serve OpenAPI docs at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

export function __resetConfigCache() {
  if (process.env.NODE_ENV !== 'production') {
    currentDomain = env.DOMAIN;
  }
}

export default app;
