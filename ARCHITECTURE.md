# microshort — Architecture

This document captures the design decisions behind every service, how they communicate, and why the key choices were made. It is the companion to the per-service READMEs, which cover APIs and configuration.

---

## System overview

microshort is a URL-shortening platform built as a set of independently deployable microservices. Each service owns its own datastore; cross-service data exchange happens exclusively over HTTP. The system is wired together through `compose.yml` and is intentionally polyglot — Node.js/TypeScript, Java/Spring Boot, PostgreSQL, MySQL, Redis, and ClickHouse — to serve as a teaching vehicle for microservices architecture, observability, authentication, secrets management, and scaling.

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
  Admin ─▶ admin-ui ─▶ admin-service (aggregates) ─▶ analytics / auth / url / config
  API user ─▶ url-service / auth-service
  every service ─▶ config-service (shared domain)
```

---

## Services

| Service | Port | Language | Datastore | Role |
|---------|------|----------|-----------|------|
| config-service | 3000 | Node.js / TypeScript | env var only | Single source of the public domain; Swagger docs at `/docs` |
| auth-service | 3001 | Node.js | PostgreSQL | User registration/login (JWT), API key issuance and validation |
| url-service | 3002 | Node.js | MySQL | Create/manage short URLs and slugs; system of record for slug → long URL |
| admin-service | 3003 | Node.js | none | Aggregation API; pulls from auth/url/analytics/config; CORS-enabled |
| admin-ui | 3004 | VanJS + htm | none | Zero-build-tool web dashboard served by Express |
| analytics-service | 3005 | Java / Spring Boot | ClickHouse | Ingests click events, stores and aggregates them, serves stats |
| redirect-service | 8080 | Node.js | Redis (cache only) | Public-facing; resolves slugs, caches them in Redis, returns 302 |

---

## Dependency graph

```
config-service  (no upstream deps)
auth-service    → config-service
url-service     → auth-service, config-service, analytics-service
redirect-service → url-service, config-service, analytics-service
admin-service   → auth-service, url-service, config-service, analytics-service
admin-ui        → admin-service
analytics-service (no upstream deps)
```

Service discovery uses Docker-internal DNS (container name). Inter-service URLs are injected as environment variables (`CONFIG_SERVICE_URL`, `AUTH_SERVICE_URL`, etc.) and default to the Docker DNS names. Never hardcode `localhost` for service-to-service calls; `localhost` only appears in host-side mappings.

---

## Data ownership

Each service owns its datastore exclusively. No service queries another service's database.

| Datastore | Owner | What lives there |
|-----------|-------|------------------|
| PostgreSQL (`auth-db`) | auth-service | users, api_keys |
| MySQL (`url-db`) | url-service | urls (slug, long_url, click_count cache) |
| Redis | shared infrastructure | redirect URL cache (owned at runtime by redirect-service); rate-limit counters (auth + url) |
| ClickHouse | analytics-service | clicks (raw events, 90-day TTL), clicks_daily (aggregating rollup) |

---

## Authentication architecture

Three distinct auth patterns are in use, each at a different layer.

### 1. End-user auth — JWT

`POST /auth/register` (201) and `POST /auth/login` (200) return a JWT signed with `JWT_SECRET`. The JWT encodes `{ userId, role }`. Services that check end-user identity (`/auth/me`, creating API keys) verify this token with `Authorization: Bearer <token>`.

Registration validates input: the email must look like an address (`x@y.tld`) and the password must be at least 8 characters. Refresh tokens are stateless (same signing key, `type: refresh` claim) and are deliberately **not** rotated or revocable — server-side session revocation is a documented follow-up exercise, in contrast with API keys, which *are* revocable.

Users have a `role` column in PostgreSQL (`user` or `admin`). Role is encoded in the JWT and returned in `getAllUsers`. Admin-only endpoints check `role === 'admin'`. The first registered user becomes admin.

### 2. API-key auth — `X-API-Key`

External callers (scripts, integrations) authenticate via API keys with the format `msh_<32-char-nanoid>`. Keys are **hashed with SHA-256 before storage** — the plaintext key is shown exactly once at creation and never stored. On validation, the key is hashed and compared against `api_keys.key_hash`.

url-service and admin-service validate API keys by calling `POST /auth/validate` on auth-service with the key. They do not verify keys locally. Keys can be revoked (`revoked_at` soft-delete); `validateApiKey` ignores revoked keys.

API-key `last_used_at` is updated asynchronously (fire-and-forget) to keep validation a read on the hot path.

### 3. Service-to-service auth — `X-Service-Token`

Internal service calls use **per-service tokens** passed as the `X-Service-Token` header, so a leaked token can be rotated without touching every service:

| Token | Held by | Accepted by | Used for |
|-------|---------|-------------|----------|
| `REDIRECT_SERVICE_TOKEN` | redirect-service | analytics-service, url-service | click-event ingestion; slug lookups (`GET /urls/:slug`) |
| `URL_SERVICE_TOKEN` | url-service | analytics-service | click-count sync (`POST /stats/counts`) |
| `ADMIN_SERVICE_TOKEN` | admin-service | auth-service, url-service, analytics-service | internal stats endpoints, admin URL updates, slug lookups |

All three are **required** (compose `:?` enforcement, envalid without default). The old shared `SERVICE_TOKEN` is deprecated but still accepted by analytics-service and url-service lookups *when set*, so a rolling migration is possible; leave it unset in new deployments. analytics-service validates the header on every request via `ServiceTokenFilter` (multi-token allow-list, fail-closed when empty).

`GET /urls/:slug` on url-service is an **internal** endpoint: it requires a valid service token, otherwise anyone who can reach port 3002 could enumerate the slug → long-URL table.

`CONFIG_WRITE_TOKEN` is a separate secret required to call `PUT /config/domain` on config-service. Admin-service holds this token and forwards it when proxying config updates.

---

## Analytics pipeline

### Design decisions (all settled)

**1. Click source of truth — ClickHouse is authoritative.**
`GET /urls/:slug` in url-service no longer increments a click counter on lookup. The redirect path is the only place a visit is recorded, via an event emitted to analytics-service. url-service keeps a denormalized `click_count` column that is refreshed by a scheduled pull from `GET /stats/counts` on analytics-service — never written on the hot path. This implements CQRS / eventual consistency and keeps url-service self-sufficient when analytics is down.

**2. Ingestion transport — asynchronous HTTP, batched, fire-and-forget.**
redirect-service buffers click events in memory and flushes them in batches to `POST /events:batch` on analytics-service. The redirect response is never delayed. The baseline is at-most-once — events can be lost on crash. The buffer is bounded (`ANALYTICS_MAX_BUFFER`, default 10 000): during a sustained analytics outage the oldest events are dropped rather than growing memory without limit, and drops are counted in the `microshort_redirect_analytics_events_dropped_total` metric. This is a deliberate teaching tradeoff; swapping the in-process buffer for Redis Streams is a documented scaling exercise.

**3. Redirect type — 302 (temporary), `Cache-Control: no-store`.**
302 ensures every visit reaches redirect-service (making analytics complete) and allows destination URLs to change. A 301 would be cached by browsers and CDNs, silently losing analytics events.

**4. Framework — Spring Boot 3.x on Java 21 (LTS).**
Spring Boot Actuator provides liveness/readiness probes and Prometheus metrics out of the box, directly satisfying the M4 observability goals. ClickHouse JDBC driver (`clickhouse-java`) is the client.

**5. Privacy — no raw IPs, 90-day TTL.**
redirect-service computes `ip_hash = SHA-256(client_ip + IP_HASH_SALT)` before the IP ever leaves the edge. The raw IP is never transmitted or stored. ClickHouse applies `TTL ts + INTERVAL 90 DAY` to raw events; daily rollups (`clicks_daily`) are retained indefinitely.

### ClickHouse schema

```sql
-- Raw events, high-volume, append-only, auto-expired after 90 days
CREATE TABLE clicks (
    slug        String,
    ts          DateTime,
    referrer    String,
    user_agent  String,
    ip_hash     FixedString(64)
) ENGINE = MergeTree
ORDER BY (slug, ts)
TTL ts + INTERVAL 90 DAY;

-- Daily rollup, retained indefinitely
CREATE TABLE clicks_daily (
    slug          String,
    day           Date,
    clicks        UInt64,
    uniq_visitors AggregateFunction(uniq, FixedString(64))
) ENGINE = AggregatingMergeTree
ORDER BY (slug, day);

CREATE MATERIALIZED VIEW clicks_daily_mv TO clicks_daily AS
SELECT slug,
       toDate(ts)         AS day,
       count()            AS clicks,
       uniqState(ip_hash) AS uniq_visitors
FROM clicks
GROUP BY slug, day;
```

### Click event contract

redirect-service emits:
```json
{
  "slug":      "abc123",
  "ts":        "2026-06-09T12:00:00Z",
  "referrer":  "https://news.example/",
  "userAgent": "Mozilla/5.0 …",
  "ipHash":    "9f86d081…"
}
```

---

## Shared Redis cache

Redis is shared infrastructure; individual services own distinct key namespaces at runtime:

| Namespace | Owner at runtime | Contents |
|-----------|-----------------|----------|
| `slug:<slug>` | redirect-service | long URL, TTL = 5 minutes (`CACHE_TTL_SECONDS`) |
| `rl-auth:<ip>` | auth-service | rate-limit counter for `/auth/register`, `/auth/login`, `/auth/refresh` |
| `rl-validate:<ip>` | auth-service | rate-limit counter for `POST /auth/validate` |
| `rl-url:<ip>` | url-service | rate-limit counter for `POST /urls` |
| `rl-redirect:<ip>` | redirect-service | rate-limit counter for `GET /:slug` |

redirect-service caches URL lookups with a 5-minute TTL and falls back to url-service on miss. Redis being down does not make redirect-service unready (`/ready` always returns 200) because it can still function via origin fallback.

---

## Configuration and secrets

### 12-factor config

All configuration is injected via environment variables, never baked into code or bundled files. This is what makes the same codebase deployable to EC2, Docker Swarm, Kubernetes, and Terraform without source changes.

### `.env` in local development

The root `.env` file is git-ignored. `.env.example` is the authoritative list of variables with placeholder values. Before running the stack:

```bash
cp .env.example .env
# edit .env with real values (for local dev, the placeholders work as-is)
```

Compose uses `:?` enforcement for required secrets so the stack fails loudly on startup rather than silently using a missing value:

```yaml
JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set in .env}
```

### Secrets summary

| Variable | Required by | Purpose |
|----------|-------------|---------|
| `JWT_SECRET` | auth-service | JWT signing key |
| `AUTH_DB_PASSWORD` | auth-service, auth-db | PostgreSQL auth |
| `URL_DB_PASSWORD` | url-service, url-db | MySQL auth |
| `URL_DB_ROOT_PASSWORD` | url-db | MySQL root setup |
| `REDIRECT_SERVICE_TOKEN` | redirect, url, analytics | redirect-service's inter-service token |
| `URL_SERVICE_TOKEN` | url, analytics | url-service's inter-service token |
| `ADMIN_SERVICE_TOKEN` | admin, auth, url, analytics | admin-service's inter-service token |
| `SERVICE_TOKEN` (optional, deprecated) | — | Legacy shared inter-service token, accepted when set |
| `IP_HASH_SALT` | redirect-service | SHA-256 salt for client IP hashing |
| `CONFIG_WRITE_TOKEN` | config-service, admin-service | Guards `PUT /config/domain` |
| `CLICKHOUSE_PASSWORD` | analytics-service, clickhouse | ClickHouse auth |

Non-secret deployment knobs: `ALLOWED_ORIGINS` (CORS allow-list for auth/url/admin — restrict to the admin-ui origin in any real deployment; defaults to `*`) and `TRUST_PROXY` (Express `trust proxy` for the rate-limited services — `1` for one proxy hop, `2` behind CloudFront → ALB, `false` when directly exposed).

**Production guard:** when `NODE_ENV=production`, every Node service refuses to start if its secrets still contain `change-me` placeholder values, and analytics-service fails closed (all 401) when no service tokens are configured.

### config-service

config-service is the single source of the public domain used in short-URL generation. It reads `DOMAIN` from its environment at startup, validates it, and serves it via `GET /config/domain`. `PUT /config/domain` updates the in-memory value only — the change resets on container restart. To persist a domain change, update `DOMAIN` in `.env` and restart config-service.

---

## Observability

All Node services expose:
- `GET /health` — liveness (no dependencies checked; always fast)
- `GET /ready` — readiness (checks datastore connectivity where applicable)
- `GET /metrics` — Prometheus metrics via prom-client (request counts, latencies, service-specific counters)

analytics-service (Spring Boot) exposes:
- `GET /actuator/health/liveness`
- `GET /actuator/health/readiness` (checks ClickHouse)
- `GET /actuator/prometheus` (exempted from the service-token filter, like the Node `/metrics` endpoints)

The `/metrics` and `/actuator/prometheus` endpoints are **unauthenticated by design** (Prometheus scrapes them) — they must only be reachable from the internal network, never from the public internet (see *Deployment exposure* below).

All services use structured JSON logging (pino for Node; ECS-format for Spring Boot) with a `X-Request-ID` propagated across service hops for distributed tracing.

Compose healthchecks and `depends_on: condition: service_healthy` enforce correct startup ordering: datastores → auth/config → url → redirect/admin.

---

## Admin UI architecture

admin-ui is a zero-build-tool single-page app. No bundler, no transpiler, no build step.

- **VanJS 1.6.0** and **htm 3.1.1** are vendored in `services/admin-ui/vendor/` and served from the UI's own static Express server. No CDN dependency.
- The API base URL is runtime-configurable via the `ADMIN_API_URL` environment variable. `server.js` serves `GET /config.js` which injects `window.ADMIN_API_BASE` into the browser; `app.js` reads this value. This allows the dashboard to work regardless of where admin-service is deployed.
- All API calls from the browser go through admin-service only — the UI never talks directly to auth-service, url-service, or analytics-service.
- Authentication is **API-key only** (`X-API-Key`, stored in `localStorage`): the dashboard has no JWT/refresh flow of its own.
- The Swagger deep-links on the Health page point at `localhost` service ports and are therefore only rendered when the UI itself is served from localhost.

---

## Design principles

1. **No shared library.** Services share contracts (HTTP, event shapes) not code. Independently buildable and replaceable.
2. **Data ownership per service.** Cross-service data only via APIs. No service queries another's database.
3. **Polyglot on purpose.** PostgreSQL, MySQL, Redis, ClickHouse, and a JVM service are intentional; students encounter heterogeneous stacks.
4. **12-factor config.** Environment-driven; no host assumptions in code. Makes the separately-taught deployment exercises possible without touching source.
5. **Make difficulties observable.** Every scaling problem, auth shortcut, and consistency tradeoff is a taught lesson, not a hidden bug. All are resolved in the roadmap; none are left permanently broken.

---

## Deployment exposure

`compose.yml` publishes service ports to the host for local development convenience. **Do not replicate that pattern 1:1 in cloud security groups.** The split is:

| Exposure | Ports | Services |
|----------|-------|----------|
| **Public** | 8080 (or 443 via a TLS proxy) | redirect-service — the only thing visitors need |
| **Public (admin)** | 3004, 3003 | admin-ui and admin-service — the browser calls admin-service directly, so both must be reachable by admins (restrict by source IP where possible; set `ALLOWED_ORIGINS`) |
| **Internal only** | 3000, 3001, 3002, 3005 | config-, auth-, url-, analytics-service — service-to-service traffic only. url-service and auth-service also serve the end-user API (`POST /urls`, `/auth/*`); expose them publicly only if that API is part of the exercise, ideally behind the same TLS proxy |
| **Never public** | 5432, 3306, 6379, 8123 | PostgreSQL, MySQL, Redis, ClickHouse. Redis has **no authentication** — anyone who can reach it can poison the `slug:` cache into an open redirect. Redis and ClickHouse are deliberately not published to the host in `compose.yml` |

Additional rules that only bite outside compose:

- **TLS terminates at a proxy** (ALB, Caddy, nginx, or an ingress controller), never in the services. Set `TRUST_PROXY` to the real hop count so rate limiting sees true client IPs, and set `DOMAIN` to the public `https://` URL.
- **On EC2, wire services together via private IPs or private DNS** — private IPs survive instance stop/start; public IPs do not. `*_SERVICE_URL` env vars exist exactly for this.
- **Every service needs a restart policy outside compose** (`restart: unless-stopped` is set in compose; use systemd units or your orchestrator's equivalent elsewhere). analytics-service in particular fails fast when ClickHouse is unreachable at boot and relies on being restarted — under Kubernetes this shows up as a normal CrashLoopBackOff until the database is ready.
- `/metrics` and `/actuator/prometheus` are unauthenticated; keep them internal.
- Swagger UIs (`/docs`) are open by design for teaching; on a public deployment, restrict or accept that your API is self-documenting to strangers.

## Deployment note

Deployment strategy (EC2/Ansible, Kubernetes, Terraform, Docker Swarm) is taught separately using this repo as the application under deployment. This document and the codebase are intentionally deployment-agnostic; no deployment tooling is prescribed here. `compose.single-service.example.yml` shows how to run one service (plus its datastore) in isolation, as needed for a one-service-per-VM deployment.
