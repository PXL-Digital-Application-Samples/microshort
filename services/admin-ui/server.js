import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pino from 'pino';
import pinoHttp from 'pino-http';
import promClient from 'prom-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const app = express();
const PORT = process.env.PORT || 3004;

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: req => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' }
}));

// Prometheus metrics setup
promClient.collectDefaultMetrics({ prefix: 'microshort_admin_ui_' });
const httpRequests = new promClient.Counter({
  name: 'microshort_admin_ui_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'status']
});

app.use((req, res, next) => {
  res.on('finish', () => {
    if (!['/health', '/ready', '/metrics'].includes(req.path)) {
      httpRequests.inc({ method: req.method, status: String(res.statusCode) });
    }
  });
  next();
});

// Content Security Policy
app.use((req, res, next) => {
  const apiBase = process.env.ADMIN_API_URL || 'http://localhost:3003';
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; connect-src 'self' ${apiBase}; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`
  );
  next();
});

// Serve static files from public — no caching in dev so fixes are picked up immediately
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/ready', (_req, res) => res.status(200).send('OK'));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// Serves runtime config to the browser. ADMIN_API_URL must be the
// host-side URL that browsers use to reach admin-service.
app.get('/config.js', (req, res) => {
  const base = process.env.ADMIN_API_URL || 'http://localhost:3003';
  res.type('application/javascript');
  res.send(`window.ADMIN_API_BASE = ${JSON.stringify(base)};`);
});

// SPA fallback - always serve index.html for any route
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Admin UI started');
});

const shutdown = (signal) => {
    logger.info({ signal }, 'Shutdown signal received — closing server');
    server.close(() => {
        logger.info('Admin UI server closed cleanly');
        process.exit(0);
    });
    setTimeout(() => {
        logger.error('Shutdown timed out — forcing exit');
        process.exit(1);
    }, 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
