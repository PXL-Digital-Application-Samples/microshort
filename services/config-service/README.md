# config-service

Single source of shared configuration for the microshort platform. Provides the public-facing domain used when generating short URLs, with runtime validation and Swagger documentation.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for how config-service fits into the overall system.

---

## Technology

- Node.js 26 / TypeScript
- Express + swagger-ui-express
- Ajv v8 + ajv-formats (schema validation)
- envalid (startup env validation)
- Vitest (tests)

---

## API endpoints

### `GET /config/domain`

Returns the current public domain.

```json
{ "domain": "http://localhost:8080" }
```

### `PUT /config/domain`

Updates the domain in memory for the current process lifetime. Requires the `X-Service-Token` header matching `CONFIG_WRITE_TOKEN`.

**This change does not persist across restarts.** To make it permanent, update `DOMAIN` in `.env` and restart the service.

```bash
curl -X PUT http://localhost:3000/config/domain \
  -H 'Content-Type: application/json' \
  -H 'X-Service-Token: <CONFIG_WRITE_TOKEN>' \
  -d '{"domain": "https://sho.rt"}'
```

The domain is validated against `config.schema.json` (must be a valid URL).

### `GET /health`

Liveness probe. Returns `{ "status": "ok" }`.

### `GET /ready`

Readiness probe. Returns `{ "status": "ready" }`.

### `GET /metrics`

Prometheus metrics.

### `GET /docs`

Interactive Swagger UI for the config-service API.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | yes | — | Public-facing base URL for short links (e.g. `https://sho.rt`) |
| `CONFIG_WRITE_TOKEN` | yes | — | Bearer token required for `PUT /config/domain` |
| `PORT` | no | `3000` | HTTP port |

---

## Development

```bash
npm install
npm run dev    # nodemon — TypeScript, hot reload
npm run build  # tsc → dist/
npm start      # node dist/index.js
npm test       # vitest (unit + integration tests)
npx vitest run -t "<test name>"   # run a single test by name
```

Tests are hermetic: they use an injected fixture domain and do not write to disk.

---

## Docker

The Dockerfile is a two-stage build: the builder stage compiles TypeScript and runs tests; the runtime stage copies only `dist/` and production dependencies. The image runs as the `node` user (non-root).

```bash
# From repo root:
docker compose up -d --build config-service
```
