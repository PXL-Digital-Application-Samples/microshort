# auth-service

User registration, login, and API key management for the microshort platform.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the authentication architecture (JWT, API key hashing, role model, inter-service validation pattern).

---

## Technology

- Node.js 26 / ESM
- Express + pino (structured JSON logging)
- PostgreSQL via `postgres` npm client
- bcryptjs (password hashing, pure-JS)
- jsonwebtoken (JWT)
- nanoid (API key generation)
- express-rate-limit + ioredis (rate limiting on login)
- prom-client (Prometheus metrics)
- envalid (startup env validation)

---

## API endpoints

### Public (no auth)

#### `POST /auth/register`

Register a new user. The first user to register receives the `admin` role; subsequent users receive `user`.

```bash
curl -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "user@example.com", "password": "securepassword"}'
```

Returns: `{ "token": "<jwt>", "userId": 1 }`

#### `POST /auth/login`

```bash
curl -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "user@example.com", "password": "securepassword"}'
```

Returns: `{ "token": "<jwt>", "userId": 1 }`

Rate-limited: 10 attempts per 15-minute window per IP (configurable via env).

#### `POST /auth/validate`

Internal endpoint for other services to validate an API key. Returns user info including `role` if the key is valid and not revoked.

```bash
curl -X POST http://localhost:3001/auth/validate \
  -H 'Content-Type: application/json' \
  -d '{"apiKey": "msh_..."}'
```

### Authenticated (JWT required — `Authorization: Bearer <token>`)

#### `GET /auth/me`

Returns the current user's profile.

#### `POST /auth/api-keys`

Generate an API key. The plaintext key is returned once and never stored.

```bash
curl -X POST http://localhost:3001/auth/api-keys \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"name": "My integration key"}'
```

Returns: `{ "apiKey": "msh_<32 chars>", "keyId": 1, "name": "My integration key" }`

Key format: `msh_` prefix followed by a 32-character nanoid.

#### `GET /auth/api-keys`

List all API keys for the current user (names and IDs, not the plaintext keys).

#### `DELETE /auth/api-keys/:keyId`

Revoke an API key (soft delete via `revoked_at`).

### Admin (API key required — `X-API-Key: msh_...` with admin role)

#### `GET /admin/users`

List all users with `id`, `email`, `role`, and `createdAt`.

#### `GET /admin/stats`

Auth-system statistics: total users, total API keys, recent signups.

### Observability

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness — always fast |
| `GET /ready` | Readiness — checks PostgreSQL connectivity |
| `GET /metrics` | Prometheus metrics |

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | yes | — | JWT signing secret |
| `DB_PASSWORD` | yes | — | PostgreSQL password |
| `DB_HOST` | no | `auth-db` | PostgreSQL host |
| `DB_PORT` | no | `5432` | PostgreSQL port |
| `DB_NAME` | no | `auth` | PostgreSQL database name |
| `DB_USER` | no | `authuser` | PostgreSQL user |
| `CONFIG_SERVICE_URL` | no | `http://config-service:3000` | Config service base URL |
| `REDIS_URL` | no | `redis://redis:6379` | Redis URL (for rate limiting) |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | no | `900000` (15 min) | Rate limit window |
| `LOGIN_RATE_LIMIT_MAX` | no | `10` | Max login attempts per window |
| `PORT` | no | `3001` | HTTP port |
| `LOG_LEVEL` | no | `info` | Pino log level |

---

## Development

```bash
npm install
npm run dev    # node --watch (hot reload)
npm start      # node src/index.js
npm test       # vitest unit tests
```

Unit tests cover key hashing and format validation without a running database.

---

## Docker

Runs as the `node` user (non-root). PostgreSQL schema is auto-applied from `init/01-schema.sql` on first boot.

```bash
# From repo root:
docker compose up -d --build auth-service
```

See `example.http` for ready-to-run API requests (VS Code REST Client / JetBrains HTTP Client).
