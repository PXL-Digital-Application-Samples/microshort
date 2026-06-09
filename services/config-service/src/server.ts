// server.ts
import express, { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import bodyParser from 'body-parser';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

const app = express();
const PORT = process.env.PORT || 3000;
const configPath = () => process.env.CONFIG_PATH || path.resolve(__dirname, '../config.json');
const CACHE_TTL_MS = 60_000;
const isDev = process.env.NODE_ENV !== 'production';

app.use(bodyParser.json());

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
app.get('/config/domain', async (_req: Request, res: Response): Promise<void> => {
  try {
    const config = await getConfig();
    res.json({ domain: config.domain });
  } catch (err) {
    console.error('Failed to read config:', err);
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
    console.error('Failed to update config:', err);
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
      ? path.join(__dirname, '../src/index.ts')  // used during development
      : path.join(__dirname, '*.js'),            // used in production after build
  ],
});

// Serve OpenAPI docs at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

export function __resetConfigCache() { cachedConfig = null; cacheTimestamp = 0; }

export default app;
