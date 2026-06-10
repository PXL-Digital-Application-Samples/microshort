# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`microshort` is a containerized URL shortener built as a set of independently deployable microservices. Each service owns its own datastore and communicates with others only over HTTP using Docker-internal DNS names — there is no shared database and no shared code library. The whole system is wired together exclusively through `compose.yml`.

For design decisions and architecture rationale, read **`ARCHITECTURE.md`** before making changes.

## Running the system

```bash
npm start                               # docker compose up -d --build --wait
npm stop                                # docker compose down
npm run reset                           # down -v + up --build --wait (wipes databases)
npm run logs                            # docker compose logs -f
docker compose up -d --build <service>  # rebuild a single service after a code change
```

- **`compose.yml`** is the canonical stack: healthchecks plus `depends_on: condition: service_healthy` enforce correct startup ordering (DBs → auth/config → url → redirect/admin).
- Secrets/passwords come from the root `.env` file. Copy `.env.example` to `.env` before running — the stack will not start without a populated `.env` (compose `:?` enforcement).

## Working inside a single service

All Node services are **ESM** (`"type": "module"`). Run them directly:

```bash
cd services/<service>
npm install
npm run dev      # node --watch (hot reload)
npm start        # node src/index.js
npm test         # vitest unit tests (auth, url, redirect only)
```

**`config-service` is TypeScript:**

```bash
cd services/config-service
npm run dev      # nodemon src/index.ts
npm run build    # tsc → dist/
npm test         # vitest
npx vitest run -t "<test name>"   # single test by name
```

**`analytics-service` is Java (Maven):**

```bash
cd services/analytics-service
mvn verify              # compile + test
mvn spring-boot:run     # run locally
```

## Running integration tests

```bash
npm install        # install vitest at root (once)
npm test           # default integration suite (excludes rate-limiting)
npm run test:e2e   # fresh stack (down -v + up --wait) then full suite
npm run test:e2e:rate  # fresh stack with rate-limit overrides then rate-limit suite
```

Individual suites: `test:auth`, `test:analytics`, `test:observability`, `test:config`, `test:admin-ui`.

## Architecture

Services and ports:

| Service | Port | Stack | Datastore | Role |
| --- | --- | --- | --- | --- |
| config-service | 3000 | Node/TypeScript | env var | Single source of shared config (the public `domain`). Swagger docs at `/docs`. |
| auth-service | 3001 | Node | PostgreSQL | User registration/login (JWT) and API-key issuance/validation. Swagger docs at `/docs`. |
| url-service | 3002 | Node | MySQL | Create/manage short URLs and slugs; system of record for slug → long URL. Swagger docs at `/docs`. |
| redirect-service | 8080 | Node | Redis (cache) | Public-facing. Resolves slugs via url-service, caches in Redis, returns 302. |
| admin-service | 3003 | Node | none | Aggregation API — pulls from auth/url/analytics/config. CORS-enabled. Swagger docs at `/docs`. |
| admin-ui | 3004 | VanJS + htm | none | Zero-build-tool dashboard. `server.js` serves static files + `/config.js`. |
| analytics-service | 3005 | Java (Spring Boot) | ClickHouse | Ingests click events from redirect-service, serves stats to admin/url. Swagger docs at `/docs`. |

Key rules:
- **No service talks to another service's database.** Cross-service data only via HTTP APIs.
- **Service discovery is by container name.** Inter-service URLs are injected as env vars. Never hardcode `localhost` for service-to-service calls.
- **API-key validation flows through auth-service.** Other services call `POST /auth/validate`; they do not verify keys locally.

Each Node service: `src/index.js` (Express + routes + `/health`), `src/db.js` (connection pool + queries, where there's a DB), `src/env.js` (envalid validation). auth-service, url-service, and redirect-service also have `src/utils.js` (pure utility functions, unit-tested with vitest). SQL schemas in `services/<service>/init/*.sql` are auto-applied on first boot.

## Notes / gotchas

- Every service exposes `GET /health` (liveness) and `GET /ready` (readiness). Container healthchecks use `/health`; keep it cheap and dependency-free.
- `example.http` files in each service are API request examples for the VS Code REST Client and JetBrains HTTP Client (not executable scripts).
- **Secrets are injected via `.env`** (Docker Compose dev) or your deployment platform's secret mechanism. The `.env.example` file is the authoritative list.
- **config-service reads `DOMAIN` from the environment**. `PUT /config/domain` changes the in-memory value only — resets on restart. To persist, update `DOMAIN` in `.env` and restart config-service.
- **admin-ui API base URL** is runtime-configurable via `ADMIN_API_URL` env var. The UI server serves `GET /config.js` which injects `window.ADMIN_API_BASE` into the browser.
- **VanJS and htm are vendored** in `services/admin-ui/vendor/`. To upgrade: download the new minified file, replace the vendored copy.
- **All Node containers run as the `node` user** (non-root). The `node:26-slim` base image ships this user at uid 1000.
