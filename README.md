# microshort

A containerized URL shortener built as a set of independently deployable microservices. Used as a teaching vehicle for microservices architecture, observability, authentication, secrets management, and cloud deployment patterns.

For design decisions and rationale see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## What does a URL shortener do?

A URL shortener turns a long, unwieldy link into a short one that redirects to it:

```
https://github.com/example/really-long-repository-name/blob/main/docs/getting-started.md
                                  │  shorten
                                  ▼
                      http://localhost:8080/xK3f9a
```

When someone opens the short link, the **redirect-service** looks up where it points and answers with an HTTP **302 redirect** — the browser then loads the original page. Every visit is also recorded as a *click event* for statistics.

### Glossary

| Term | Meaning |
|------|---------|
| **Long URL** | The original destination, e.g. `https://example.com/some/very/long/path` |
| **Slug** | The short identifier at the end of a short link — the `xK3f9a` in `http://localhost:8080/xK3f9a`. Auto-generated (6 random characters) or chosen by the user (`customSlug`, e.g. `my-launch`). Each slug maps to exactly one long URL. |
| **Short URL** | `<domain>/<slug>` — the domain comes from config-service, the slug from url-service |
| **Redirect (302)** | The "temporarily moved" HTTP answer that sends a browser from the short URL to the long one. 302 (not 301) so browsers don't cache it — every visit reaches our server and can be counted. |
| **JWT** | The login token you get from `POST /auth/register` / `/auth/login`. Sent as `Authorization: Bearer <token>`; used for account actions like managing API keys. |
| **API key** | A long-lived credential (`msh_…`) for scripts and tools, sent as `X-API-Key`. This is what you use to create short URLs — and what the admin dashboard logs in with. Shown once at creation, then only stored as a hash. |
| **Service token** | A shared secret (`X-Service-Token`) that the services use to talk to *each other* — e.g. redirect-service proving to url-service that a slug lookup is legitimate. Users never send these. |
| **Click event** | One record per visit (slug, timestamp, referrer, user agent, hashed IP) sent by redirect-service to analytics-service |

### Try it: your first short link

With the stack running (see Quick start below), from a terminal:

```bash
# 1. Register (the FIRST user automatically becomes admin).
#    Password must be at least 8 characters. Returns 201 + a JWT token.
curl -s -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"super-secret-1"}'
# → {"token":"eyJ...","refreshToken":"...","userId":1}

# 2. Create an API key using that JWT (replace eyJ... with your token).
#    The msh_... key is shown ONCE — copy it.
curl -s -X POST http://localhost:3001/auth/api-keys \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' -d '{"name":"my first key"}'
# → {"apiKey":"msh_...","keyId":1,"name":"my first key"}

# 3. Shorten a URL with the API key.
curl -s -X POST http://localhost:3002/urls \
  -H 'X-API-Key: msh_...' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://en.wikipedia.org/wiki/URL_shortening"}'
# → {"shortUrl":"http://localhost:8080/xK3f9a","slug":"xK3f9a",...}

# 4. Follow it (-I shows the 302 redirect instead of downloading the page).
curl -I http://localhost:8080/xK3f9a
# → HTTP/1.1 302 Found
# → Location: https://en.wikipedia.org/wiki/URL_shortening
```

Open the short URL in a browser a few times, then log in to the **admin dashboard** at http://localhost:3004 with your `msh_…` API key to see users, URLs, and click statistics (counts sync from analytics about once a minute).

---

## Services

| Service | Port | Stack | Role |
|---------|------|-------|------|
| config-service | 3000 | Node.js / TypeScript | Shared configuration (public domain). Swagger docs at `/docs`. |
| auth-service | 3001 | Node.js / PostgreSQL | User registration, login (JWT), API key management |
| url-service | 3002 | Node.js / MySQL | URL shortening, slug management |
| admin-service | 3003 | Node.js | Aggregation API for the dashboard; no direct DB access |
| admin-ui | 3004 | VanJS + htm | Zero-build-tool web dashboard |
| analytics-service | 3005 | Java / Spring Boot / ClickHouse | Click ingestion and statistics |
| redirect-service | 8080 | Node.js / Redis | Public-facing redirect handler (302) |

```
                ┌─────────────────┐
  Visitor ─────▶│ redirect-service│──▶ Redis (URL cache)
                │   :8080         │──▶ url-service ──▶ MySQL
                └────────┬────────┘
                         │ fire-and-forget click event
                         ▼
                ┌─────────────────┐
                │analytics-service│──▶ ClickHouse
                │   :3005 (Java)  │
                └────────▲────────┘
  Admin ─▶ admin-ui ─▶ admin-service ─▶ analytics / auth / url / config
  API user ─▶ url-service (API key required)
  every service ─▶ config-service (shared domain)
```

---

## Quick start

**Requires:** Docker with Compose v2 (`docker compose`).

```bash
# 1. Create your .env file (placeholders work for local dev)
cp .env.example .env

# 2. Start the full stack (builds images, waits for healthchecks)
npm start
# or: docker compose up -d --build --wait

# 3. Open the admin dashboard
open http://localhost:3004

# 4. Stop
npm stop
# or: docker compose down

# 5. Reset (wipe databases and restart fresh)
npm run reset
# or: docker compose down -v && docker compose up -d --build --wait
```

### Service endpoints

| URL | Description |
|-----|-------------|
| http://localhost:8080 | Short URL redirects (public) |
| http://localhost:3004 | Admin UI dashboard |
| http://localhost:3000/docs | Config service — Swagger UI |
| http://localhost:3001 | Auth service |
| http://localhost:3002 | URL service |
| http://localhost:3003 | Admin service API |
| http://localhost:3005/actuator/health | Analytics service health |

### Rebuilding a single service after a code change

```bash
docker compose up -d --build <service-name>
# example: docker compose up -d --build url-service
```

### Viewing logs

```bash
npm run logs
# or: docker compose logs -f
# or for a single service: docker compose logs -f url-service
```

---

## Development (individual service)

All Node services are ESM (`"type": "module"`) with no build step. Run them directly after `npm install`:

```bash
cd services/<service>
npm install
npm run dev      # node --watch (hot reload)
npm start        # node (production-style)
npm test         # unit tests (where available)
```

**config-service is TypeScript and requires a build step:**

```bash
cd services/config-service
npm install
npm run dev    # nodemon (TypeScript)
npm run build  # tsc → dist/
npm test       # vitest
```

**analytics-service is Java (Maven):**

```bash
cd services/analytics-service
mvn verify              # compile + test
mvn spring-boot:run     # run locally (requires ClickHouse)
```

---

## Testing

### Integration tests (root)

Black-box tests against the live running stack. Require the full Docker stack to be up.

```bash
npm install           # install vitest at root
npm test              # run default suite (excludes rate-limiting)
npm run test:auth          # tests/integration/auth — API keys, roles, config auth
npm run test:analytics     # tests/integration/analytics — click ingestion and statistics
npm run test:observability # readiness, Prometheus metrics, request-ID propagation, Redis cache
npm run test:config        # config-service domain, Ajv validation, secrets/env validation
npm run test:admin-ui      # admin-ui runtime config, vendored libs, camelCase consistency
npm run test:e2e      # fresh stack (down -v → up --wait) then full suite
npm run test:e2e:rate # fresh stack with rate-limit overrides then rate-limit suite
```

The suite targets `localhost` by default, but every base URL can be overridden so the same tests double as a post-deployment smoke test:

```bash
BASE_URL_REDIRECT=https://sho.rt BASE_URL_AUTH=https://auth.internal:3001 \
BASE_URL_ADMIN=https://admin-api.sho.rt SKIP_DB_RESET=true npm test
```

(`SKIP_DB_RESET=true` disables the local `docker compose exec` database resets, which only work against the local stack.)

### Service-level unit tests

```bash
cd services/config-service && npm test     # TypeScript unit tests (vitest)
cd services/auth-service && npm test       # key hashing and format tests (vitest)
cd services/url-service && npm test        # slug validation tests (vitest)
cd services/redirect-service && npm test   # ip hash and event buffer tests (vitest)
```

analytics-service tests run as part of the Maven build:

```bash
cd services/analytics-service && mvn verify
```

### API exploration

Each service directory contains an `example.http` file with ready-to-run requests for the [VS Code REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) and JetBrains HTTP Client:

```
services/auth-service/example.http
services/url-service/example.http
services/redirect-service/example.http
services/admin-service/example.http
```

---

## Configuration

All configuration is injected via environment variables. Copy `.env.example` to `.env` before starting the stack:

```bash
cp .env.example .env
```

The placeholders in `.env.example` work for local development. For production, replace every `change-me-in-production` value with a real secret.

See [ARCHITECTURE.md — Configuration and secrets](./ARCHITECTURE.md#configuration-and-secrets) for the full variable reference and the rationale for the 12-factor approach.

---

## Per-service documentation

| Service | README |
|---------|--------|
| config-service | [services/config-service/README.md](./services/config-service/README.md) |
| auth-service | [services/auth-service/README.md](./services/auth-service/README.md) |
| url-service | [services/url-service/README.md](./services/url-service/README.md) |
| redirect-service | [services/redirect-service/README.md](./services/redirect-service/README.md) |
| admin-service | [services/admin-service/README.md](./services/admin-service/README.md) |
| admin-ui | [services/admin-ui/README.md](./services/admin-ui/README.md) |
| analytics-service | [services/analytics-service/README.md](./services/analytics-service/README.md) |
