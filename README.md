# microshort

A containerized URL shortener built as a set of independently deployable microservices. Used as a teaching vehicle for microservices architecture, observability, authentication, secrets management, and cloud deployment patterns.

For design decisions and rationale see [ARCHITECTURE.md](./ARCHITECTURE.md).

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
npm run test:auth          # API keys, roles, config auth, rate-limit happy path
npm run test:analytics     # click event ingestion and statistics
npm run test:observability # readiness, Prometheus metrics, request-ID propagation, Redis cache
npm run test:config        # config-service domain, Ajv validation, secrets/env validation
npm run test:admin-ui      # admin-ui runtime config, vendored libs, camelCase consistency
npm run test:e2e      # fresh stack (down -v → up --wait) then full suite
npm run test:e2e:rate # fresh stack with rate-limit overrides then rate-limit suite
```

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
