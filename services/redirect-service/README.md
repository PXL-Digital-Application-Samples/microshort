# redirect-service

Public-facing redirect handler. Resolves short slugs to long URLs via url-service, caches them in Redis, returns 302 redirects, and emits click events to analytics-service (fire-and-forget, batched).

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the analytics pipeline design: why 302 (not 301), the ip-hash privacy model, and the at-most-once event delivery tradeoff.

---

## Technology

- Node.js 26 / ESM
- Express + pino (structured JSON logging)
- ioredis (URL cache)
- prom-client (Prometheus metrics, including cache hit/miss counters)
- envalid (startup env validation)

---

## How it works

1. Request arrives for `GET /:slug`
2. Check Redis cache for the slug
3. On cache miss: call `GET /urls/:slug` on url-service; cache the result for 5 minutes
4. Return `302` redirect with `Cache-Control: no-store`
5. Asynchronously buffer a click event and flush to analytics-service in batches

The 302 status code ensures every visit hits redirect-service (enabling complete analytics). `Cache-Control: no-store` prevents browsers and CDNs from caching the redirect response.

---

## API endpoints

### `GET /`

Home page — simple HTML with service info.

### `GET /:slug`

Redirect to the long URL associated with the slug.
- `302 Found` with `Location: <longUrl>` and `Cache-Control: no-store` if found
- `404` HTML page if the slug does not exist

### Observability

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness — always fast |
| `GET /ready` | Readiness — always 200 (stateless; Redis down is not unready) |
| `GET /metrics` | Prometheus metrics (cache hits, cache misses, redirects) |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICE_TOKEN` | yes | — | Inter-service auth token for analytics calls |
| `IP_HASH_SALT` | yes | — | Salt for `SHA-256(client_ip + salt)` before storing `ip_hash` |
| `URL_SERVICE_URL` | no | `http://url-service:3002` | URL service base URL |
| `CONFIG_SERVICE_URL` | no | `http://config-service:3000` | Config service base URL |
| `ANALYTICS_SERVICE_URL` | no | `http://analytics-service:3005` | Analytics service base URL |
| `REDIS_URL` | no | `redis://redis:6379` | Redis URL (for URL cache) |
| `ANALYTICS_BATCH_SIZE` | no | `50` | Max events per flush to analytics |
| `ANALYTICS_FLUSH_MS` | no | `5000` | Flush interval in milliseconds |
| `PORT` | no | `8080` | HTTP port |
| `LOG_LEVEL` | no | `info` | Pino log level |

---

## Development

```bash
npm install
npm run dev    # node --watch (hot reload)
npm start      # node src/index.js
npm test       # vitest unit tests
```

Unit tests cover the ip hashing function and event buffer logic without a running Redis or analytics service.

---

## Docker

Runs as the `node` user (non-root). No persistent storage.

```bash
# From repo root:
docker compose up -d --build redirect-service
```

See `example.http` for ready-to-run API requests (VS Code REST Client / JetBrains HTTP Client).
