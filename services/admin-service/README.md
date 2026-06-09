# admin-service

Aggregation API for the microshort admin dashboard. Pulls data from auth-service, url-service, config-service, and analytics-service over HTTP. Has no database of its own.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the role-based authentication model and the resilient aggregation pattern (partial results + `degraded` flag when upstream services are unavailable).

---

## Technology

- Node.js 26 / ESM
- Express + cors + pino (structured JSON logging)
- prom-client (Prometheus metrics)
- envalid (startup env validation)

---

## API endpoints

All endpoints require an admin API key: `X-API-Key: msh_...` (admin role).

### `GET /admin/dashboard`

System overview aggregated from all services. Returns user counts, URL counts, recent stats, top URLs by clicks, and analytics totals. If analytics-service is unavailable, the response still includes data from the other services and sets `degraded: ["analytics"]`.

```json
{
  "users": { "total": 42, "recentSignups": 5 },
  "urls":  { "total": 318, "recentUrls": 12 },
  "clicks": { "total": 15240, "last7Days": 1082 },
  "topUrls": [{ "slug": "abc123", "clicks": 204 }],
  "degraded": []
}
```

### `GET /admin/users`

List all users (proxied from auth-service). Returns `id`, `email`, `role`, `createdAt`.

### `GET /admin/urls`

List all URLs (proxied from url-service). Returns camelCase fields: `id`, `shortUrl`, `longUrl`, `slug`, `clicks`, `userId`, `createdAt`.

### `GET /admin/search/urls?q=<term>`

Search URLs by slug or long URL (DB-side query via url-service). Returns up to 100 results. Returns `400` if `?q` is missing or empty.

### `GET /admin/users/:userId`

Not yet implemented (`501`). Tracked for a future milestone.

### `GET /admin/config`

Read the current domain from config-service.

### `PUT /admin/config`

Update the domain in config-service (in-memory, resets on restart). Requires `CONFIG_WRITE_TOKEN` to be set.

### `GET /admin/health/services`

Health status of all upstream services (auth, url, config, analytics, redis).

### Observability

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness — always fast |
| `GET /ready` | Readiness — always 200 (no DB dependency) |
| `GET /metrics` | Prometheus metrics |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICE_TOKEN` | yes | — | Inter-service auth token for analytics calls |
| `CONFIG_WRITE_TOKEN` | yes | — | Token forwarded to config-service for domain updates |
| `AUTH_SERVICE_URL` | no | `http://auth-service:3001` | Auth service base URL |
| `URL_SERVICE_URL` | no | `http://url-service:3002` | URL service base URL |
| `CONFIG_SERVICE_URL` | no | `http://config-service:3000` | Config service base URL |
| `ANALYTICS_SERVICE_URL` | no | `http://analytics-service:3005` | Analytics service base URL |
| `PORT` | no | `3003` | HTTP port |
| `LOG_LEVEL` | no | `info` | Pino log level |

---

## Development

```bash
npm install
npm run dev    # node --watch (hot reload)
npm start      # node src/index.js
```

No unit tests (business logic is HTTP aggregation; covered by root integration tests).

---

## Docker

Runs as the `node` user (non-root). No persistent storage.

```bash
# From repo root:
docker compose up -d --build admin-service
```

See `example.http` for ready-to-run API requests (VS Code REST Client / JetBrains HTTP Client).
