# PLANNING — microshort

> Companion to [CODE_REVIEW.md](./CODE_REVIEW.md). This document sequences the
> work needed to turn the current prototype into a coherent microservices teaching
> platform. **M1 is complete** (2026-06-09); see milestone notes below.

## 1. What this project is for

microshort is a **teaching vehicle for microservices design**. It is used across
several courses, and the *same* codebase is later deployed many different ways —
EC2 with Ansible, then as containers, then on Kubernetes, then provisioned with
Terraform, and so on — and used to teach **monitoring, scaling pain, authentication,
and secrets management**.

Two consequences shape everything below:

1. **Deployment strategy is explicitly out of scope for this plan.** How the
   system is shipped (EC2/Ansible/Terraform/Kubernetes) is taught *using* the
   repo and is decided per-course. This document plans the *application and its
   services* only. We keep the app deployment-agnostic and 12-factor-friendly,
   but we do not design or prescribe any deployment here.
2. **The "difficulties" are taught by fixing them — every one is planned to be
   resolved.** The per-instance redirect cache, the file-on-disk config store,
   the plaintext `.env` secrets, and the missing role model have real pedagogical
   value (students hit the scaling / auth / secrets wall first-hand), but **none
   is left broken on purpose.** Each has a fix scheduled in the roadmap below; the
   lesson is the journey from the limitation to its resolution, not the
   limitation itself. There is no "won't fix" list.

## 2. Current state (one paragraph)

Six services exist as small Express apps (config, auth, url, redirect, admin,
admin-ui); auth→PostgreSQL, url→MySQL, the rest are stateless. The happy path
(register → API key → shorten → redirect → admin dashboard) is wired and works
locally via `compose.yml`. All services build reproducibly on Node 26, have
committed lockfiles, and are covered by CI (npm ci + syntax + docker build +
/health smoke). The **analytics-service does not exist** (only stubs and an
empty `url_analytics` table point at it), several admin features are 501 stubs,
and auth/roles are hard-coded (`user_id === 1`). See CODE_REVIEW.md for the
itemised list; see IMPLEMENTATION_PLAN_M1.md for what M1 resolved.

## 3. Guiding principles for the work

- **Keep services independently buildable and replaceable.** No shared library
  that couples them at build time; share *contracts* (HTTP, schemas), not code.
- **Data ownership stays per-service.** Cross-service data only via APIs.
- **Polyglot on purpose.** PostgreSQL, MySQL, and (incoming) ClickHouse + a JVM
  service are intentional, so students see heterogeneous stacks.
- **12-factor config.** Everything environment-driven; no host assumptions baked
  into code or client bundles. This makes the (separately taught) deployments
  possible without touching source.
- **Make the difficulties observable, not invisible.** A scaling problem you can
  measure is a good lesson; a silent one is a trap.

## 4. Target architecture

```
                 ┌──────────────┐
 Visitor ───────▶│ redirect-svc │──▶ shared cache (Redis, M4)
                 │              │──▶ url-svc ──▶ MySQL
                 └──────┬───────┘                │
                        │                         └──▶ auth-svc ──▶ PostgreSQL
                        │ (fire-and-forget click event)
                        ▼
                 ┌──────────────┐
                 │ analytics-svc│──▶ ClickHouse      ◀── NEW (Java)
                 │   (Java)     │
                 └──────▲───────┘
 Admin ─▶ admin-ui ─▶ admin-svc ─(aggregates)─▶ auth / url / analytics / config
 every service ─▶ config-svc (shared settings)
```

The single new component is the **Java analytics-service backed by ClickHouse**
(§6). Everything else is consolidation of what already exists.

## 5. Roadmap

Milestones are ordered by dependency, not by calendar. Each item references the
CODE_REVIEW finding it resolves. **Every CODE_REVIEW finding — including the
design choices in CR §8.2 — is covered by a milestone below; nothing is left as
"won't fix."** (Only CR §8.1 — polyglot persistence and per-service data
ownership — is deliberately retained.)

### M1 — Stabilise the core (correctness) ✅ COMPLETE
Goal: the stack builds reproducibly and every service starts cleanly.
- Fix config-service double-`listen` via an app/server split (CR 1.1). ✅
- Make config-service tests hermetic — fixture config, restore on teardown,
  don't write the repo file (CR 1.2). ✅
- Commit `package-lock.json` for all JS services; switch Dockerfiles to
  `npm ci` (CR 6.1). ✅
- Align CI Node version with the images (Node 26 — current stable) and extend
  CI beyond config-service (CR 6.6). ✅
- Replace string-match duplicate detection with constraint/SQLSTATE checks
  (CR 2.5); drop `node-fetch` and add `AbortSignal.timeout` (CR 4.3). ✅
- Swap `bcrypt` for `bcryptjs` (pure-JS) to avoid native compilation in Docker.
  CI workflows added for all 5 JS services (npm ci + syntax + build + /health smoke).

Notes:
- All images use `node:26-slim` (Node 26 = current stable as of June 2026).
- Corporate SSL proxy requires `npm config set strict-ssl false` in Dockerfiles.
- `bcryptjs` is a drop-in replacement for `bcrypt` with identical API.

### M2 — Authentication & authorization maturity *(core teaching topic)*
Goal: turn the placeholder auth into something worth teaching with.
- Introduce a real **role** concept (e.g. `users.role` + a claim), replacing the
  hard-coded `user_id === 1` in all three services (CR 2.1).
- Centralise the "is admin" decision in auth-service so it isn't reimplemented
  in url/admin (CR 4.1).
- Hash API keys at rest; compare hashes on validation (CR 2.2).
- Decide and implement one revocation model (soft-delete `revoked_at`, and have
  `validateApiKey` honour it) (CR 2.4).
- Decouple `last_used_at` updates from the validation hot path (async/batched),
  so validation can be a read (CR 2.3). (May be used as a "find the write
  hotspot" exercise first, but the milestone's deliverable is the fix.)
- Add authentication to `PUT /config/domain` (CR 2.7).
- Add rate limiting to `/auth/login` and URL creation.

### M3 — Analytics-service (Java + ClickHouse) — **build per §6**
Goal: stand up the new service and rewire click tracking around it. The design is
finalised in §6 (all decisions made); this milestone implements it.
- Scaffold the Spring Boot 3.x / Java 21 / Maven service on port 3005, with
  Actuator health + Prometheus metrics and `X-Service-Token` auth (§6.2).
- Create the ClickHouse schema: raw `clicks` (90-day TTL) + `clicks_daily`
  aggregating rollup via materialized view (§6.5).
- Implement ingestion (`/events`, `/events:batch`) and the stats query API
  (§6.3).
- Rewire redirect-service: 302 + `Cache-Control: no-store`, edge-side `ip_hash`,
  buffered fire-and-forget emit replacing the `logRedirect` stub (CR 3.2/3.3).
- Rewire url-service: drop increment-on-lookup; `click_count` becomes a cache
  refreshed from `GET /stats/counts` (CR 3.1).
- Rewire admin-service dashboard to source click metrics from analytics (§6.6).
- Add the analytics-service + ClickHouse containers to both compose files, and a
  `mvn verify` CI job (§6.7).

### M4 — Observability, monitoring & shared state *(core teaching topic)*
Goal: make the system measurable, and make stateful components survive scaling.
- Liveness vs. readiness split: `/health` stays cheap (liveness); add `/ready`
  that checks the datastore, wiring the existing unused `checkHealth()`
  (CR 6.2).
- Structured (JSON) logging with a request/correlation ID propagated across
  service hops (CR 6.7).
- A `/metrics` endpoint per service (request counts/latencies, cache hit rate
  for redirect, validation rate for auth).
- Graceful shutdown on `SIGTERM` (drain server, close pools) (CR 6.3).
- Replace redirect-service's per-instance `Map` cache with a shared/external
  cache (e.g. Redis) so horizontally-scaled instances share hit state — making
  the architecture diagram's "shared cache" real and removing the
  per-instance-cache difficulty (CR §8.2; relates to click counting, CR 3.1).
- Harden admin-service as a resilient aggregator (CR §8.2): per-call timeouts
  (CR 4.3), short-lived response caching, and graceful degradation so one slow or
  down dependency doesn't fail the whole dashboard.

### M5 — Configuration & secrets *(core teaching topic)*
Goal: make config and secrets a first-class, teachable concern.
- Replace config-service's file-on-disk store with a backed store (a small DB, or
  external/orchestrator-provided config) so settings survive restarts and stay
  consistent across replicas (CR §8.2, 6.2). Students may first observe the
  file-store limitation, but the milestone's deliverable is the backed store.
- Validate config against the existing `config.schema.json` at load and on PUT
  (CR 7.2).
- Remove committed secrets from `.env`; provide a `.env.example` with
  placeholders and document a secret-injection story the (separately taught)
  deployments can satisfy (CR 2.6).

### M6 — Admin UI & API consistency
Goal: keep the zero-build (VanJS + htm) UI, but make it work anywhere and have
the API speak one dialect (CR §8.2).
- Make the admin-ui API base URL runtime-configurable (e.g. a small
  `/config.js` served by the UI server, or a reverse-proxy same-origin setup)
  instead of the hard-coded `localhost:3003` (CR 5.1).
- Vendor VanJS/htm into the repo and serve them from the UI's own static server
  (keeping the zero-build approach) so the UI works offline and isn't hostage to
  public CDNs (CR 5.2).
- Standardise the admin API on one casing (camelCase) end-to-end so the UI stops
  special-casing shapes (CR 4.2).
- Implement or formally retire the 501 stubs (`/admin/users/:id`,
  in-memory search) (CR 4.4).

### M7 — Consistency, docs & tests
Goal: the repo describes itself accurately and is safe to change.
- Reconcile README + `architecture.mermaid` with reality once analytics lands;
  settle analytics-service as **Java + ClickHouse** everywhere (CR 7.1).
- Collapse the two compose files (or generate one from the other) to stop drift
  (CR 6.5).
- Add per-service smoke/contract tests and bring every service under CI.
- Optional hardening exercise: non-root container `USER` (CR 6.4).

## 6. Design: analytics-service (Java + ClickHouse)

The one genuinely new service, and the project's **JVM** and
**columnar-analytics** representative. The design below is final — all earlier
open questions are resolved in §6.1. Implementation is sequenced in **M3**; the
build itself has not started.

### 6.1 Resolved design decisions
The five open questions are settled as follows. Each decision favours a clear
teaching arc over the theoretically purest option.

1. **Click source of truth → ClickHouse is authoritative; url-service stops
   counting on lookup.** The increment-on-lookup in `GET /urls/:slug` is removed
   (fixes CR 3.1). The redirect path is the *only* place a "visit" is recorded,
   and it records it by emitting an event to analytics-service. url-service keeps
   a denormalized `click_count` column purely as an **eventually-consistent
   cache** for its "my URLs" list, refreshed by a scheduled pull from
   analytics-service — never written on the hot path. This deliberately teaches
   CQRS / denormalization / eventual consistency, and keeps url-service
   self-sufficient (it serves stale counts if analytics is down).

2. **Ingestion transport → asynchronous HTTP, batched, fire-and-forget.**
   redirect-service buffers events in memory and flushes them to analytics in
   small batches (`POST /events:batch`), never blocking the redirect. The
   baseline is *at-most-once* (drop after a bounded retry) — losing some events
   under failure is acceptable for analytics and is itself the lesson. A later
   iteration swapping the in-process buffer for an external broker (Redis
   Streams / Kafka) is documented as a scaling exercise, but the broker is **not**
   part of the baseline build.

3. **Redirect type → 302 (temporary), with `Cache-Control: no-store`.** Changed
   from 301 so every visit reaches redirect-service (making analytics complete)
   and so targets can change (fixes CR 3.3). The SEO/cacheability advantage of
   301 is noted but not worth losing all analytics fidelity here.

4. **Framework → Spring Boot 3.x on Java 21 (LTS), built with Maven.** Chosen for
   teaching familiarity and because **Spring Boot Actuator** provides
   liveness/readiness probes and Prometheus metrics out of the box, directly
   satisfying the M4 observability goals. The ClickHouse JDBC driver
   (`clickhouse-java`) is the client. (Quarkus/Javalin are lighter but less
   commonly taught; rejected for that reason.)

5. **Retention / privacy → no raw IPs; hashed at the edge; 90-day raw TTL.**
   redirect-service computes `ip_hash = SHA-256(client_ip + salt)` before the IP
   ever leaves the edge; the raw IP is never transmitted or stored. The salt is a
   secret injected per the M5 secrets story. ClickHouse applies a `TTL ts +
   INTERVAL 90 DAY` to raw events, while daily rollups are retained indefinitely
   via an aggregating materialized view. No geolocation in the baseline (a coarse
   country derived at the edge before hashing is a documented optional
   extension).

### 6.2 Service shape
- **Stack:** Java 21, Spring Boot 3.x (Spring Web + Actuator), Maven, ClickHouse
  via `clickhouse-java` JDBC.
- **Port:** `3005` (next free after the existing 3000–3004 / 8080 allocation).
- **Datastore:** ClickHouse (HTTP `8123`, native `9000`), owned exclusively by
  this service — no other service reads it directly (upholds CR §8.1).
- **Auth:** every endpoint is internal-only and protected by a shared
  `SERVICE_TOKEN` (an `X-Service-Token` header), validated against an injected
  secret. This is service-to-service auth, deliberately distinct from end-user
  auth (which stays in auth-service): the only callers are redirect-service
  (ingest) and admin-service (queries); public users never reach analytics
  directly. Centralising the *end-user* admin decision still happens in
  auth-service per M2 — admin-service authenticates the human, then calls
  analytics with the service token.
- **Observability:** Actuator `/actuator/health/{liveness,readiness}` (readiness
  pings ClickHouse), `/actuator/prometheus` for metrics, JSON logging with the
  correlation ID propagated from the caller (aligns with M4).

### 6.3 HTTP API
Ingestion (called by redirect-service):
```
POST /events            # single event,  → 202 Accepted
POST /events:batch      # array of events,→ 202 Accepted
```
Queries (called by admin-service):
```
GET /stats/overview                       # totals + last-7-day + approx unique visitors
GET /stats/top?limit=10&since=ISO         # top slugs by clicks
GET /stats/slug/{slug}?from=&to=          # per-slug: totals, referrer & UA breakdown
GET /stats/timeseries?slug=&from=&to=&interval=day
GET /stats/counts?slugs=a,b,c             # bulk slug→count, for url-service cache sync
```
All require `X-Service-Token`. Stats endpoints support an ISO-8601 time window.

### 6.4 Event contract
redirect-service emits this (fire-and-forget, batched):
```json
{
  "slug": "abc123",
  "ts": "2026-06-09T12:00:00Z",
  "referrer": "https://news.example/",
  "userAgent": "Mozilla/5.0 …",
  "ipHash": "9f86d081…"          // SHA-256(client_ip + salt), computed at the edge
}
```
analytics-service validates the shape, rejects malformed events (4xx on the
batch, but redirect-service ignores the response), and inserts the rest.

### 6.5 ClickHouse schema
```sql
-- Raw events: high-volume, append-only, auto-expired after 90 days.
CREATE TABLE clicks (
    slug        String,
    ts          DateTime,
    referrer    String,
    user_agent  String,
    ip_hash     FixedString(64)
) ENGINE = MergeTree
ORDER BY (slug, ts)
TTL ts + INTERVAL 90 DAY;

-- Daily rollup: retained indefinitely, fed automatically from `clicks`.
CREATE TABLE clicks_daily (
    slug          String,
    day           Date,
    clicks        UInt64,
    uniq_visitors AggregateFunction(uniq, FixedString(64))
) ENGINE = AggregatingMergeTree
ORDER BY (slug, day);

CREATE MATERIALIZED VIEW clicks_daily_mv TO clicks_daily AS
SELECT slug,
       toDate(ts)        AS day,
       count()           AS clicks,
       uniqState(ip_hash) AS uniq_visitors
FROM clicks
GROUP BY slug, day;
```
This supersedes the unused `url_analytics` table in MySQL (CR 3.2): analytics
data leaves the url-service store entirely, preserving per-service data
ownership. Overview/top/timeseries queries read the rollup; per-slug detail can
drill into raw `clicks` within the 90-day window.

### 6.6 Integration changes in existing services
- **redirect-service** — switch to `302` + `Cache-Control: no-store`; compute
  `ip_hash` at the edge; replace the `logRedirect()` `console.log` stub (CR 3.2)
  with the buffered, fire-and-forget `POST /events:batch` to analytics; carry the
  `SERVICE_TOKEN`.
- **url-service** — remove `incrementClicks` from `GET /urls/:slug` (CR 3.1);
  repurpose `clicks` → `click_count` as a cache; add a scheduled job that calls
  `GET /stats/counts` to refresh it; drop the click aggregates from
  `/admin/stats`.
- **admin-service** — `/admin/dashboard` sources all click/engagement metrics
  from analytics-service (overview + top), joined with auth (user) and url (URL
  count) stats; calls analytics with the service token.
- **admin-ui** — the dashboard's "Top URLs by clicks" and totals now reflect
  analytics data (no client change beyond the casing fix in CR 4.2).
- **compose** — replace the commented-out analytics block with the real
  analytics-service build; add a `clickhouse/clickhouse-server` container with
  the schema mounted at init; add both to `compose.yml` and `compose-simple.yml`;
  healthcheck analytics via `/actuator/health`.
- **secrets/config** — introduce `SERVICE_TOKEN` and `IP_HASH_SALT` as injected
  secrets (M5); analytics needs no config-service dependency (it builds no short
  URLs).

### 6.7 Build & CI
- Multi-stage Dockerfile: Maven build + tests → slim Temurin JRE 21 runtime, run
  as a non-root user (consistent with the M7 hardening item).
- Add a Maven `mvn verify` job to CI for the service (extends CR 6.6 beyond
  config-service).

## 7. Explicitly out of scope (for this plan)

- **Any deployment design**: EC2/Ansible, container orchestration, Kubernetes
  manifests, Terraform, cloud provider choices, ingress/load-balancing, TLS
  termination. These are taught separately and per-course using this repo as-is.
- **Performance tuning beyond what a lesson needs.** We surface bottlenecks
  deliberately rather than pre-optimising them away.

## 8. Decision log / open questions for the maintainer

- Confirm the M-ordering. (Per maintainer decision, every found issue — including
  the CR §8.2 design choices — is planned for resolution; nothing is left in a
  permanently broken state. Only CR §8.1, polyglot persistence and per-service
  data ownership, is deliberately retained.)
- The analytics-service design is finalised (§6.1 resolves all prior open
  questions); M3 is ready to build. 301→**302** is confirmed by the maintainer.
  The remaining reversible call to be aware of: url-service keeping an
  eventually-consistent `click_count` cache rather than dropping click counts
  entirely.
- **admin-ui stays a zero-build app** (maintainer's call delegated; decided). M6
  therefore keeps the VanJS + htm approach but **vendors both libraries locally**
  (served by the UI's own static server) instead of loading them from public
  CDNs — preserving the no-bundler simplicity while fixing the offline /
  supply-chain / host-coupling issues (CR 5.2).
