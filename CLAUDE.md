# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`microshort` is a containerized URL shortener built as a set of independently deployable microservices. Each service owns its own datastore and communicates with others only over HTTP using Docker-internal DNS names — there is no shared database and no shared code library. The whole system is wired together exclusively through `compose.yml`.

## Running the system

```bash
docker compose up -d          # build + start everything
docker compose logs -f        # tail logs
docker compose down           # stop (add -v to wipe DB volumes)
./quickstart.sh               # build, wait for health, print URLs + example commands (quickstart.ps1 on Windows)
```

- **`compose.yml`** is the canonical stack: healthchecks plus `depends_on: condition: service_healthy` enforce correct startup ordering (DBs → auth/config → url → redirect/admin).
- **`compose-simple.yml`** is a lighter variant (no healthchecks, plain `depends_on`) for faster local iteration. Use `docker compose -f compose-simple.yml up`.
- Secrets/passwords come from the root `.env` file via `${VAR:-default}` substitution; defaults are baked in for local dev.

To rebuild a single service after a code change: `docker compose up -d --build <service-name>`.

## Working inside a single service

All Node services are **ESM** (`"type": "module"`) with no build step and no test suite — run them directly:

```bash
cd services/<service>
npm install
npm run dev      # node --watch src/index.js  (hot reload)
npm start        # node src/index.js
```

**`config-service` is the exception** — it is TypeScript and the only service with tests and CI:

```bash
cd services/config-service
npm run dev                       # nodemon src/index.ts
npm run build                     # tsc -> dist/
npm test                          # vitest (watch)
npx vitest run                    # single CI-style run
npx vitest run -t "<test name>"   # run one test by name
```

CI (`.github/workflows/config-service.yml`) only covers `config-service` — it runs vitest, builds the Docker image, and pushes to GHCR. The other services have no automated tests or pipeline.

## Architecture

Services and ports:

| Service | Port | Stack | Datastore | Role |
| --- | --- | --- | --- | --- |
| config-service | 3000 | Node/TypeScript | `config.json` file | Single source of shared config (the public `domain`). Serves Swagger docs at `/docs`. |
| auth-service | 3001 | Node | PostgreSQL | User registration/login (JWT) and API-key issuance/validation. Keys are `msh_<nanoid>`. |
| url-service | 3002 | Node | MySQL | Create/manage short URLs and slugs; the system of record for slug → long URL. |
| redirect-service | 8080 | Node | in-memory cache only | Public-facing. Resolves slugs via url-service, caches them, returns 301. Stores nothing persistently. |
| admin-service | 3003 | Node | none | Aggregation API — pulls from auth/url/config over HTTP, holds no DB of its own. CORS-enabled. |
| admin-ui | 3004 | VanJS + htm | none | Dashboard. **Zero build tools**: `server.js` is a static Express server; UI logic is hand-written ES modules in `app.js` + `components/`. |

Key cross-service rules:

- **No service talks to another service's database.** Need data that lives elsewhere → call that service's HTTP API. `admin-service` and `redirect-service` have no datastore at all by design.
- **Service discovery is by container name.** Inter-service URLs are injected as env vars (`CONFIG_SERVICE_URL`, `AUTH_SERVICE_URL`, `URL_SERVICE_URL`) pointing at internal DNS like `http://config-service:3000`. Never hardcode `localhost` for service-to-service calls; localhost ports are host-side mappings only.
- **Config is centralized.** Any service that needs the public domain reads it from config-service rather than its own env. Add new shared settings there (and to `config.schema.json`), not as per-service env vars.
- **API-key auth flows through auth-service.** url-service validates incoming API keys by calling auth-service; it does not verify keys locally.

Each Node service follows the same shape: `src/index.js` (Express app + routes + `/health`) and, where there's a DB, a `src/db.js` that owns a connection pool and exports query functions. SQL schemas live in `services/<service>/init/*.sql` and are auto-applied by the Postgres/MySQL containers on first boot via `docker-entrypoint-initdb.d`.

## Project status docs

This is a teaching prototype under active development. Two docs are the source of truth for state and direction — read them before making changes:
- **`CODE_REVIEW.md`** — current state, bugs, and known issues (tagged), with a findings index.
- **`PLANNING.md`** — the roadmap (milestones M1–M7) and the finalized analytics-service design. All design decisions are settled there; e.g. the redirect will move `301 → 302`, and click-tracking becomes ClickHouse-authoritative.

## Notes / gotchas

- The **analytics-service** (referenced in the README, `architecture.mermaid`, the `url_analytics` table, and redirect-service's `logRedirect` stub) is **not yet implemented** — it's commented out in `compose.yml` with no `services/` directory. It is planned as **Java (Spring Boot) + ClickHouse** (PLANNING.md §6); ignore the older "Node.js"/"MongoDB" labels if you still find them anywhere.
- Every service exposes `GET /health`; container healthchecks depend on it, so keep it cheap and dependency-free.
- `example.http` / `example.ps1` files in each service, plus root `full-example.{sh,ps1}` and `admin-example.{sh,ps1}`, are the canonical request examples for manual end-to-end testing.
