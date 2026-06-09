// server.ts
import express, { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import bodyParser from 'body-parser';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import promClient from 'prom-client';

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
const PORT = process.env.PORT || 3000;
const configPath = () => process.env.CONFIG_PATH || path.resolve(__dirname, '../config.json');
const CACHE_TTL_MS = 60_000;
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

type Config = {
  domain: string;
};

// In-memory config cache
let cachedConfig: Config | null = null;
let cacheTimestamp = 0;

// Read config from disk
async function loadConfig(): Promise<Config> {
  const data = await fs.readFile(configPath(), 'utf-8');
  return JSON.parse(data);
}

// Save config to disk and update cache
async function saveConfig(newConfig: Config): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify(newConfig, null, 2), 'utf-8');
  cachedConfig = newConfig;
  cacheTimestamp = Date.now();
}

// Get config, using cache if valid
async function getConfig(): Promise<Config> {
  if (cachedConfig && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  const config = await loadConfig();
  cachedConfig = config;
  cacheTimestamp = Date.now();
  return config;
}

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
app.get('/config/domain', async (req: Request, res: Response): Promise<void> => {
  try {
    const config = await getConfig();
    res.json({ domain: config.domain });
  } catch (err) {
    (req as any).log.error({ err }, 'Failed to read config');
    res.status(500).json({ error: 'Internal server error' });
  }
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
app.put('/config/domain', async (req: Request, res: Response): Promise<void> => {
  try {
    const expected = process.env.CONFIG_WRITE_TOKEN;
    if (!expected || req.headers['x-service-token'] !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { domain } = req.body;
    if (!domain || typeof domain !== 'string') {
      res.status(400).json({ error: 'Invalid or missing domain' });
      return;
    }

    const updatedConfig: Config = { domain };
    await saveConfig(updatedConfig);
    res.json({ message: 'Domain updated', domain });
  } catch (err) {
    (req as any).log.error({ err }, 'Failed to update config');
    res.status(500).json({ error: 'Internal server error' });
  }
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
app.get('/ready', async (req: Request, res: Response): Promise<void> => {
  try {
    await loadConfig();
    res.json({ status: 'ready' });
  } catch (err) {
    (req as any).log.error({ err }, 'Readiness check failed');
    res.status(503).json({ status: 'unavailable', detail: (err as Error).message });
  }
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
    isDev
      ? path.join(__dirname, '../src/server.ts')  // updated to point to server.ts directly
      : path.join(__dirname, '*.js'),
  ],
});

// Serve OpenAPI docs at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

export function __resetConfigCache() { cachedConfig = null; cacheTimestamp = 0; }

export default app;
