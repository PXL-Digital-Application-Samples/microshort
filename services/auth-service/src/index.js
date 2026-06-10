import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';
import { createUser, findUserByEmail, getUserById, createApiKey, validateApiKey, getUserApiKeys, revokeApiKey, getAllUsers, getAuthStats, checkHealth, sql } from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pinoHttp from 'pino-http';
import { randomUUID, timingSafeEqual, createHash } from 'crypto';
import promClient from 'prom-client';
import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import logger from './logger.js';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const servicePrefix = 'microshort_auth_';
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

// Custom metric: API key validation counter
const apiKeyValidations = new promClient.Counter({
  name: 'microshort_auth_api_key_validations_total',
  help: 'API key validation results',
  labelNames: ['result']   // 'valid', 'invalid'
});

const rateLimitBypass = new promClient.Counter({
  name: 'microshort_auth_rate_limit_bypass_total',
  help: 'Times rate limiting was bypassed due to Redis store unavailability'
});

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000
});

redis.on('error', err => {
  logger.warn({ err }, 'Redis store unavailable — rate limiting bypassed (passOnStoreError=true)');
  rateLimitBypass.inc();
});

const app = express();
const PORT = env.PORT;
const JWT_SECRET = env.JWT_SECRET;

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

// Rate limiter for authentication routes
const authLimiter = rateLimit({
  windowMs: parseInt(env.LOGIN_RATE_LIMIT_WINDOW_MS),
  limit:    parseInt(env.LOGIN_RATE_LIMIT_MAX),
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-auth:'
  }),
  message: { error: 'Too many attempts, please try again later' }
});

const validateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 500,
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-validate:'
  }),
  message: { error: 'Too many validation requests' }
});

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Admin API key verification middleware
const requireAdmin = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  try {
    const keyData = await validateApiKey(apiKey);
    if (!keyData || keyData.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.admin = keyData;
    next();
  } catch (err) {
    req.log.error({ err }, 'requireAdmin error');
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Service token verification middleware
function safeTokenEqual(a, b) {
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const requireServiceToken = (req, res, next) => {
  const token = req.headers['x-service-token'] ?? '';
  if (!env.ADMIN_SERVICE_TOKEN || !safeTokenEqual(env.ADMIN_SERVICE_TOKEN, token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

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
 *       503:
 *         description: Database unavailable
 */
app.get('/ready', async (req, res) => {
  const ok = await checkHealth();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});

// Metrics check
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 minLength: 1
 *                 example: "s3cr3t"
 *     responses:
 *       200:
 *         description: Registration successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 userId:
 *                   type: integer
 *       400:
 *         description: Email or password missing
 *       409:
 *         description: Email already in use
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(email, passwordHash);

    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
    const refreshToken = jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: env.REFRESH_TOKEN_EXPIRES_IN });
    res.json({ token, refreshToken, userId: user.id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    req.log.error({ err }, 'Registration error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Log in and obtain JWT tokens
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 userId:
 *                   type: integer
 *       400:
 *         description: Email or password missing
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
    const refreshToken = jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: env.REFRESH_TOKEN_EXPIRES_IN });
    res.json({ token, refreshToken, userId: user.id });
  } catch (err) {
    req.log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for a new access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *       400:
 *         description: Refresh token missing or wrong type
 *       401:
 *         description: Invalid or expired refresh token
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/auth/refresh', authLimiter, async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(400).json({ error: 'Invalid token type' });
    }
    const user = await getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
    res.json({ token });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get the current user's profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 email:
 *                   type: string
 *                 role:
 *                   type: string
 *                   example: user
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Missing or invalid JWT
 */
app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const user = await findUserByEmail(req.user.email);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.created_at
    });
  } catch (err) {
    req.log.error({ err }, 'Profile error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /admin/users:
 *   get:
 *     summary: List all users (admin)
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *         description: Pagination cursor (user ID offset)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Paginated user list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       email:
 *                         type: string
 *                       role:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                 nextCursor:
 *                   type: integer
 *                   nullable: true
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const cursor = req.query.cursor ? parseInt(req.query.cursor) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
    const result = await getAllUsers({ cursor, limit });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'Admin users error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /admin/stats:
 *   get:
 *     summary: Get auth statistics (admin)
 *     tags: [Admin]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Auth service statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalUsers:
 *                   type: integer
 *                 recentUsers:
 *                   type: integer
 *                 totalApiKeys:
 *                   type: integer
 *       401:
 *         description: API key missing or invalid
 *       403:
 *         description: Admin role required
 */
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await getAuthStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Admin stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /internal/admin/stats:
 *   get:
 *     summary: Get auth statistics (internal service-to-service)
 *     tags: [Internal]
 *     security:
 *       - serviceToken: []
 *     responses:
 *       200:
 *         description: Auth service statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalUsers:
 *                   type: integer
 *                 recentUsers:
 *                   type: integer
 *                 totalApiKeys:
 *                   type: integer
 *       401:
 *         description: Service token missing or invalid
 */
app.get('/internal/admin/stats', requireServiceToken, async (req, res) => {
  try {
    const stats = await getAuthStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Internal stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/api-keys:
 *   post:
 *     summary: Generate a new API key
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: My CLI key
 *     responses:
 *       200:
 *         description: API key created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKey:
 *                   type: string
 *                 keyId:
 *                   type: integer
 *                 name:
 *                   type: string
 *       401:
 *         description: Missing or invalid JWT
 */
app.post('/auth/api-keys', verifyToken, async (req, res) => {
  try {
    const { name } = req.body;
    const apiKey = await createApiKey(req.user.userId, name || 'Unnamed key');

    res.json({
      apiKey: apiKey.key,
      keyId: apiKey.id,
      name: apiKey.name
    });
  } catch (err) {
    req.log.error({ err }, 'API key generation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/validate:
 *   post:
 *     summary: Validate an API key (used by other services)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [apiKey]
 *             properties:
 *               apiKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: API key is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   example: true
 *                 userId:
 *                   type: integer
 *                 keyId:
 *                   type: integer
 *                 role:
 *                   type: string
 *                 isAdmin:
 *                   type: boolean
 *       400:
 *         description: apiKey field missing
 *       401:
 *         description: API key is invalid or revoked
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/auth/validate', validateLimiter, async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'API key required' });
    }

    const keyData = await validateApiKey(apiKey);
    if (!keyData) {
      apiKeyValidations.inc({ result: 'invalid' });
      return res.status(401).json({ error: 'Invalid API key' });
    }

    apiKeyValidations.inc({ result: 'valid' });
    res.json({
      valid: true,
      userId: keyData.user_id,
      keyId: keyData.id,
      role: keyData.role,
      isAdmin: keyData.role === 'admin'
    });
  } catch (err) {
    req.log.error({ err }, 'Validation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/api-keys:
 *   get:
 *     summary: List the current user's API keys
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of API key metadata (key values are not returned)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       lastUsedAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *       401:
 *         description: Missing or invalid JWT
 */
app.get('/auth/api-keys', verifyToken, async (req, res) => {
  try {
    const keys = await getUserApiKeys(req.user.userId);

    // Don't return the actual key values, just metadata
    const safeKeys = keys.map(k => ({
      id: k.id,
      name: k.name,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at
    }));

    res.json({ keys: safeKeys });
  } catch (err) {
    req.log.error({ err }, 'List keys error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /auth/api-keys/{keyId}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: API key revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: API key revoked
 *                 keyId:
 *                   type: integer
 *       400:
 *         description: Invalid key ID
 *       401:
 *         description: Missing or invalid JWT
 *       404:
 *         description: API key not found or not owned by caller
 */
app.delete('/auth/api-keys/:keyId', verifyToken, async (req, res) => {
  try {
    const keyId = parseInt(req.params.keyId);

    if (isNaN(keyId)) {
      return res.status(400).json({ error: 'Invalid key ID' });
    }

    const result = await revokeApiKey(req.user.userId, keyId);
    if (!result) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key revoked', keyId: result.id });
  } catch (err) {
    req.log.error({ err }, 'Revoke key error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Auth Service API',
      version: '1.0.0',
      description: 'User registration, login, JWT issuance, and API key management.'
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    components: {
      securitySchemes: {
        bearerAuth:   { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey:       { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        serviceToken: { type: 'apiKey', in: 'header', name: 'X-Service-Token' }
      }
    }
  },
  apis: [join(__dirname, 'index.js')]
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Auth service started');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received — draining connections');
    server.close(async () => {
      try {
        await sql.end();
        logger.info('Postgres connection pool closed');
      } catch (err) {
        logger.error({ err }, 'Error closing Postgres connection pool');
      }
      try {
        await redis.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.error({ err }, 'Error closing Redis connection');
      }
      logger.info('Auth service shut down cleanly');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

export { app };
