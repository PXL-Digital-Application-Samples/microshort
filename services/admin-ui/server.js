import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3004;

// Serve static files
app.use(express.static(__dirname));

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.get('/ready', (_req, res) => res.status(200).send('OK'));

// Serves runtime config to the browser. ADMIN_API_URL must be the
// host-side URL that browsers use to reach admin-service.
app.get('/config.js', (req, res) => {
  const base = process.env.ADMIN_API_URL || 'http://localhost:3003';
  res.type('application/javascript');
  res.send(`window.ADMIN_API_BASE = ${JSON.stringify(base)};`);
});

// SPA fallback - always serve index.html for any route
app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
    console.log(`Admin UI running on port ${PORT}`);
    console.log(`Access the admin UI at http://localhost:${PORT}`);
});

const shutdown = (signal) => {
    console.log(`Shutdown signal received (${signal}) — closing server`);
    server.close(() => {
        console.log('Admin UI server closed cleanly');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('Shutdown timed out — forcing exit');
        process.exit(1);
    }, 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
