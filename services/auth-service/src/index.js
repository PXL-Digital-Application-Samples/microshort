import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createUser, findUserByEmail, createApiKey, validateApiKey, getUserApiKeys, revokeApiKey, getAllUsers, getAuthStats, checkHealth, sql } from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import promClient from 'prom-client';
import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000
});

redis.on('error', err => logger.error({ err }, 'Redis error'));

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

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

// Rate limiter for authentication routes
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? String(15 * 60 * 1000)),
  limit:    parseInt(process.env.LOGIN_RATE_LIMIT_MAX ?? '10'),
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-auth:'
  }),
  message: { error: 'Too many attempts, please try again later' }
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

// Health check (liveness)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Readiness check
app.get('/ready', async (req, res) => {
  const ok = await checkHealth();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});

// Metrics check
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Register new user
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(email, passwordHash);
    
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    req.log.error({ err }, 'Registration error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
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

    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id });
  } catch (err) {
    req.log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user profile
app.get('/auth/me', verifyToken, async (req, res) => {
  try {
    const user = await findUserByEmail(req.user.email);
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

// Admin: Get all users (requires admin API key)
app.get('/admin/users', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Check if admin
    const keyData = await validateApiKey(apiKey);
    if (!keyData || keyData.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const users = await getAllUsers();
    res.json({ users });
  } catch (err) {
    req.log.error({ err }, 'Admin users error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get auth stats
app.get('/admin/stats', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    const keyData = await validateApiKey(apiKey);
    if (!keyData || keyData.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await getAuthStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Admin stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate API key
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

// Validate API key (for other services to use)
app.post('/auth/validate', async (req, res) => {
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

// List user's API keys
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

// Revoke an API key
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

const server = app.listen(PORT, () => {
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
  
  // Force-quit if graceful drain takes > 30 s
  setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));