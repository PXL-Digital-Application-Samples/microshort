# url-service

URL shortening and slug management. Owns the slug → long URL mapping and maintains an eventually-consistent click-count cache refreshed from analytics-service.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the CQRS/eventual-consistency click-count design and why url-service no longer writes click counts on the hot path.

---

## Technology

- Node.js 26 / ESM
- Express + pino (structured JSON logging)
- MySQL via `mysql2` connection pool
- nanoid (auto-slug generation)
- express-rate-limit + ioredis (rate limiting on URL creation)
- prom-client (Prometheus metrics)
- envalid (startup env validation)

---

## API endpoints

### Internal (service token)

#### `GET /urls/:slug`

Resolve a slug to a long URL. Called by redirect-service with `X-Service-Token: <REDIRECT_SERVICE_TOKEN>` (admin/legacy tokens are also accepted). Requests without a valid token get 401 — this endpoint must not be publicly reachable, or the slug table becomes enumerable.

```json
{ "longUrl": "https://example.com/…", "slug": "abc123" }
```

### API key authenticated (`X-API-Key: msh_...`)

#### `POST /urls`

Create a short URL. Requires a valid API key.

```bash
curl -X POST http://localhost:3002/urls \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: msh_...' \
  -d '{"url": "https://example.com/very/long/url"}'

# With a custom slug:
  -d '{"url": "https://example.com/very/long/url", "customSlug": "mylink"}'
```

Returns: `{ "shortUrl": "http://localhost:8080/abc123", "slug": "abc123", "longUrl": "…" }`

Auto-slugs are 6 random alphanumeric characters (nanoid). Custom slugs must match `/^[a-zA-Z0-9_-]+$/` and be ≤ 50 characters.

Rate-limited: 30 creations per minute per IP (configurable via env).

#### `GET /urls`

List all URLs for the authenticated user.

#### `DELETE /urls/:slug`

Delete a URL. Only the owner can delete their own URLs.

### Admin (API key required — admin role)

#### `GET /admin/urls?q=<search>`

List all URLs. Optional `?q=` parameter filters by slug or long URL (DB-side LIKE query, max 100 results).

#### `GET /admin/stats`

URL statistics: total URLs, total clicks (cache from analytics), recent creations, top URLs by clicks.

### Observability

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness — always fast |
| `GET /ready` | Readiness — checks MySQL connectivity |
| `GET /metrics` | Prometheus metrics (request counts, slug creation type) |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_PASSWORD` | yes | — | MySQL password |
| `URL_SERVICE_TOKEN` | yes | — | Token url-service presents to analytics-service |
| `ADMIN_SERVICE_TOKEN` | yes | — | Token accepted from admin-service |
| `REDIRECT_SERVICE_TOKEN` | yes | — | Token accepted on slug lookups |
| `SERVICE_TOKEN` | no | — | Legacy shared token (deprecated, optional) |
| `DB_HOST` | no | `url-db` | MySQL host |
| `DB_PORT` | no | `3306` | MySQL port |
| `DB_NAME` | no | `urlshort` | MySQL database name |
| `DB_USER` | no | `urluser` | MySQL user |
| `AUTH_SERVICE_URL` | no | `http://auth-service:3001` | Auth service base URL |
| `CONFIG_SERVICE_URL` | no | `http://config-service:3000` | Config service base URL |
| `ANALYTICS_SERVICE_URL` | no | `http://analytics-service:3005` | Analytics service base URL |
| `REDIS_URL` | no | `redis://redis:6379` | Redis URL (for rate limiting) |
| `URL_RATE_LIMIT_WINDOW_MS` | no | `60000` (1 min) | Rate limit window |
| `URL_RATE_LIMIT_MAX` | no | `30` | Max URL creations per window |
| `PORT` | no | `3002` | HTTP port |
| `LOG_LEVEL` | no | `info` | Pino log level |

---

## Development

```bash
npm install
npm run dev    # node --watch (hot reload)
npm start      # node src/index.js
npm test       # vitest unit tests
```

Unit tests cover slug validation and format without a running database.

---

## Docker

Runs as the `node` user (non-root). MySQL schema is auto-applied from `init/01-schema.sql` on first boot.

```bash
# From repo root:
docker compose up -d --build url-service
```

See `example.http` for ready-to-run API requests (VS Code REST Client / JetBrains HTTP Client).
