# microshort — Comprehensive Code & Architecture Review

> Reviewed: 2026-06-10  
> Reviewer: Claude Sonnet 4.6  
> Scope: All 7 services, integration tests, CI workflows, Docker/Compose config

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Assessment](#2-architecture-assessment)
3. [Security Findings](#3-security-findings)
4. [Per-Service Findings](#4-per-service-findings)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Intentional Tradeoffs](#6-intentional-tradeoffs)
7. [Prioritized Findings Table](#7-prioritized-findings-table)

---

## 1. Executive Summary

`microshort` is a well-structured, polyglot microservices URL shortener. The architecture documentation in `ARCHITECTURE.md` is unusually honest — it names its own tradeoffs, explains every non-obvious choice, and distinguishes intentional teaching decisions from production shortcuts. The code follows those documented principles more consistently than most systems of this size.

**What works well:**
- Hard service-boundary enforcement (no cross-service DB access anywhere in the codebase)
- Comprehensive observability contract: Prometheus metrics, structured JSON logging, X-Request-ID propagation, and `/health`/`/ready`/`/metrics` on every service
- Graceful shutdown (SIGTERM drain → flush → force-quit after 30s) implemented identically across all Node services
- Environment validation at startup (envalid everywhere) prevents misconfigured-at-runtime failures
- CI workflows cover unit tests, syntax checking, Docker build smoke tests, and integration tests — all gated on PRs

**Where it needs work:**
- One exploitable open-redirect vulnerability (no URL scheme allowlist)
- A reserved-slug shadowing bug that silently breaks slugs named "health", "ready", or "metrics"
- Duplicate inline auth logic in three services creates maintenance and correctness risk
- compiled Java `target/` directory tracked in git (no `.gitignore` for analytics-service)
- Test helpers contain a hardcoded database password

None of the real defects are architecture-level. They are localized and individually fixable in < 1 hour each.

---

## 2. Architecture Assessment

### 2.1 Adherence to the Five Design Principles

`ARCHITECTURE.md` states five explicit principles. Here is how the code measures up:

**1. "No shared databases — each service owns its data."**
Fully enforced. Zero cross-service DB connections in any `db.js` or `ClickHouseRepository`. Data sharing happens only through HTTP APIs. The SQL schemas are isolated under `services/<name>/init/`.

**2. "Service discovery by container name, never localhost."**
Fully enforced. All inter-service URLs are injected via `env.js`/`application.properties` and validated at startup. No hardcoded `localhost` in service source. The test helper `setup.js` and integration tests use `localhost` correctly (they're running outside the Docker network).

**3. "API-key validation flows through auth-service."**
Largely enforced. All external API-key consumers call `POST /auth/validate`. The inconsistency is that auth-service and url-service `/admin/*` routes do this validation with inline code rather than the `validateApiKey` middleware — see §4. The logic is correct, just duplicated.

**4. "302 not 301, Cache-Control: no-store."**
Correctly implemented in `redirect-service/src/index.js:258-259`. The design rationale (analytics completeness, invalidation cost) is sound and implemented exactly as documented.

**5. "Make difficulties observable, not invisible."**
Followed consistently. Every service logs startup parameters, sync job outcomes, flush results, and degraded-mode states. The analytics pipeline's at-most-once delivery is explicitly logged, not silently dropped. `admin-service` `/admin/dashboard` returns a `degraded` array naming which upstream failed rather than a generic 500.

### 2.2 Dependency Graph Enforcement

The `compose.yml` `depends_on` conditions enforce exactly the documented startup order (DBs → auth/config → url → redirect/admin). `analytics-service` uses `condition: service_started` in redirect-service's dependency, which is correct — redirect-service can buffer events before analytics is healthy.

### 2.3 Auth Architecture

The three-layer auth pattern (JWT for human sessions, API keys for programmatic access, X-Service-Token for service-to-service) is clean and consistently applied. The separation prevents common cross-tier mistakes: services never accept JWTs where API keys should be used, and the config/analytics internal services correctly reject anything without the service token.

One structural gap: `POST /auth/validate` is entirely unauthenticated and unrate-limited. This endpoint's purpose is to be called by other services, which is correct, but it's also reachable from outside the stack if port 3001 is exposed. An attacker with a leaked partial key could abuse this for key enumeration. This is discussed further in §3.

---

## 3. Security Findings

### 3.1 Open Redirect — URL Scheme Not Allowlisted `[MEDIUM]`

**File:** `services/url-service/src/index.js:192-196`

```js
try {
  new URL(url);
} catch {
  return res.status(400).json({ error: 'Invalid URL format' });
}
```

`new URL()` validates syntax, not scheme. `javascript:alert(1)`, `data:text/html,<script>...`, and `file:///etc/passwd` all pass this check. They are stored in MySQL and served at `GET /urls/:slug`.

`redirect-service/src/index.js:259` then issues `res.redirect(302, redirectUrl)` with no scheme check. Modern browsers block `javascript:` and `data:` targets from HTTP `Location` headers, so browser-based XSS is largely mitigated. The real risk is for non-browser HTTP clients (curl, mobile apps, webhooks, API consumers) that follow the 302 and receive a `javascript:` or `data:` payload verbatim. It is also trivially bad hygiene — allowing these schemes to be stored is confusing and unexpected.

Fix is two lines:

```js
const parsed = new URL(url);
if (!['http:', 'https:'].includes(parsed.protocol)) {
  return res.status(400).json({ error: 'Only http/https URLs are allowed' });
}
```

### 3.2 Reserved-Slug Shadowing `[MEDIUM]`

**Files:** `services/url-service/src/utils.js:4`, `services/redirect-service/src/index.js:172-184`

`isValidSlug` accepts any string matching `[a-zA-Z0-9_-]+` up to 50 characters. The strings `health`, `ready`, `metrics`, and (in principle) any future operational path are all valid per this rule. A user can successfully create a short URL with slug `health`:

```
POST /urls  { "url": "https://example.com", "customSlug": "health" }
→ 201 Created, shortUrl: "https://sho.rt/health"
```

But when accessed via `GET /health` on the redirect service, Express matches the route registered at line 172 first and returns `200 OK` instead of redirecting. The user's URL is permanently unreachable via that slug.

Fix: add a `RESERVED_SLUGS` set to the url-service slug validator, or register the `/:slug` handler before the operational routes and check for reserved names inside it.

### 3.3 XSS in Redirect Root Page `[MEDIUM]`

**File:** `services/redirect-service/src/index.js:214`

```js
res.send(`...
  <p>Domain: <code>${config.domain}</code></p>
...`);
```

The domain string is fetched from config-service and interpolated into an HTML response without escaping. AJV validates the domain as a URI format (`ajv-formats`), which does reject `<script>` tags, so this is only exploitable if the domain passes URI validation (e.g., `http://evil.com/<img+onerror=...)` — some browsers tolerate angle brackets in URIs). The immediate fix is `config.domain.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))`.

The deeper fix is Content Security Policy on all HTML responses, which also protects admin-ui (see §5.4).

### 3.4 First-User-Admin Race Condition `[MEDIUM]`

**File:** `services/auth-service/src/db.js:18-27`

```js
const [{ count }] = await sql`SELECT COUNT(*) as count FROM users`;
const role = parseInt(count) === 0 ? 'admin' : 'user';
const [user] = await sql`INSERT INTO users ...`;
```

The `COUNT(*) → INSERT` is two separate statements. Under concurrent first-registration requests (race window is sub-millisecond but real), both could see `count = 0` and both become admin. The `INSERT` has a `UNIQUE` constraint on `email` so duplicate registrations with the same address will fail, but two different first-time registrations in a race both succeed with `role = 'admin'`.

Fix: use a single `INSERT ... SELECT` with a CTE, or use `INSERT ... ON CONFLICT` with the role logic expressed in SQL.

### 3.5 Non-Constant-Time Token Comparison `[LOW]`

**Files:** `services/config-service/src/server.ts:134`, `services/analytics-service/.../ServiceTokenFilter.java`

```ts
if (!expected || req.headers['x-service-token'] !== expected) {
```

JavaScript's `!==` and Java's `String.equals` are not constant-time. A sufficiently patient attacker on the same L2 segment could theoretically mount a timing attack to infer `CONFIG_WRITE_TOKEN`. The fix is `crypto.timingSafeEqual` (Node) or `MessageDigest.isEqual` with HMAC (Java):

```ts
import { timingSafeEqual } from 'crypto';
const buf = (s: string) => Buffer.from(s);
if (!timingSafeEqual(buf(expected), buf(token))) { ... }
```

Risk is low (tokens are long random strings, timing is noisy over HTTP), but this is a one-line fix.

### 3.6 Rate Limiters Are Fail-Open `[MEDIUM]`

**Files:** `services/auth-service/src/index.js:91`, `services/url-service/src/index.js:95`

Both rate limiters are configured with `passOnStoreError: true`:

```js
const authLimiter = rateLimit({
  ...
  passOnStoreError: true,   // ← fail-open
  store: new RedisStore(...)
});
```

If Redis becomes unavailable (crash, network partition, OOM), the rate limiters silently pass all requests through. Brute-force protection on `/auth/register` and `/auth/login` and creation-rate protection on `POST /urls` disappear exactly when the Redis cluster is under stress — which is precisely when an attacker would try to exploit them. The `passOnStoreError` default is deliberate (better to allow users in than to DOS your own service), but the failure mode should be visible: add a metric increment or log at `warn` level when the store error path is taken, so operators know rate limiting has silently degraded.

### 3.8 `POST /auth/validate` Unauthenticated and Unrate-Limited `[LOW]`

**File:** `services/auth-service/src/index.js:260-286`

The endpoint has no rate limiting and accepts requests from any caller that can reach port 3001. In the compose stack this port is internal-only, but if auth-service is ever port-forwarded or deployed with a public port, this endpoint becomes a free API-key oracle. Adding the same `authLimiter` (or a more permissive dedicated limiter) would cap brute-force attempts.

### 3.7 Wildcard CORS `[LOW]`

**Files:** `services/auth-service/src/index.js:70`, `services/url-service/src/index.js:74`, `services/admin-service/src/index.js:51`

All three use `cors()` with no options, which responds with `Access-Control-Allow-Origin: *`. Because auth is header-based (not cookies), CSRF is not a concern — but wildcard CORS allows any website to make authenticated API calls on behalf of users who happen to have their API key in a browser context (e.g., admin-ui). Restricting to known origins is simple: `cors({ origin: env.ALLOWED_ORIGINS })`.

### 3.8 `admin-ui` Static File Serving Exposes Server Source `[LOW]`

**File:** `services/admin-ui/server.js` (implicit, via `express.static(__dirname)`)

```js
app.use(express.static(__dirname));
```

This serves every file in the working directory, including `server.js` itself. Any user of the admin UI can request `http://admin-ui:3004/server.js` and read the server source. No secrets are hardcoded in the file, but it is still unintentional information disclosure. Fix: `express.static(path.join(__dirname, 'public'))` or explicitly list allowed static directories.

---

## 4. Per-Service Findings

### 4.1 auth-service

**Duplicate inline admin validation (3 occurrences)**

`/admin/users` (line 200) and `/admin/stats` (line 222) each replicate the following pattern inline:

```js
const apiKey = req.headers['x-api-key'];
if (!apiKey) return res.status(401).json(...);
const keyData = await validateApiKey(apiKey);
if (!keyData || keyData.role !== 'admin') return res.status(403).json(...);
```

The `validateApiKey` middleware already exists for other routes. These two admin routes should use it. As written, a future change to validation logic requires finding all three copies.

**`isValidApiKeyFormat` is dead code**

`services/auth-service/src/utils.js` exports `isValidApiKeyFormat` (checks for `msh_` prefix and length 36) and it is tested by `utils.test.js`. However, neither `validateApiKey` in `db.js` nor any route handler calls it. The check is silently skipped: a key with the wrong format hits the database with its SHA-256 hash and returns a miss. The format check should be added to the hot path in `validateApiKey` (before hashing and querying) to short-circuit on obviously invalid keys.

**`last_used_at` update uses `console.error` instead of pino logger**

`services/auth-service/src/db.js:66`: The fire-and-forget `sql` call on error falls back to `console.error`. Every other service uses the pino instance for structured logging. This error is invisible to log aggregators that parse JSON.

**No limit on `getAllUsers`**

`services/auth-service/src/db.js:104-116`: `SELECT * FROM users ORDER BY created_at DESC` with no `LIMIT`. At scale, this is a full-table scan sent as a single response payload.

**JWT carries mutable role**

`services/auth-service/src/index.js:145,175`: JWTs embed the user's `role`. If an admin is demoted, their existing (up-to-7-day) tokens still carry `role: 'admin'`. The system has no JWT revocation and no re-fetch from the database on JWT use. This is an accepted tradeoff for stateless auth, but worth documenting as a known-elevated-privilege window.

### 4.2 url-service

**TOCTOU window on slug creation**

`services/url-service/src/index.js:210-216`:

```js
const existing = await getUrlBySlug(slug);
if (existing) return res.status(409).json({ error: 'Slug already in use' });
const urlRecord = await createUrl(req.user.id, url, slug);
```

Check and insert are separate statements. Two concurrent requests with the same custom slug both pass the check, then one fails on the database `UNIQUE` constraint. This is acceptable for custom slugs (the 409 is the safety net), but for auto-generated slugs (`nanoid(6)`) the collision probability is low enough that the current approach is fine. The code should handle the MySQL duplicate-key error code `ER_DUP_ENTRY` and return a 409 rather than 500 on the constraint violation.

**`syncClickCounts` query string grows unbounded**

`services/url-service/src/index.js:388-404`:

```js
const [rows] = await pool.execute('SELECT slug FROM urls');
const slugs = rows.map(r => r.slug).join(',');
const res = await fetch(`${ANALYTICS_SERVICE_URL}/stats/counts?slugs=${encodeURIComponent(slugs)}`, ...);
```

With 100,000 URLs at 6-8 chars each, this query string exceeds 700 KB — well past common HTTP server limits (Nginx default: 8 KB headers). The fix is to paginate or send slugs in a `POST` body.

**`getAllUrls` hard-caps at 1000 with no pagination**

`services/url-service/src/db.js`: `SELECT * FROM urls ORDER BY created_at DESC LIMIT 1000`. The admin URL list silently truncates and provides no cursor. Admin-service consumers have no way to request the next page.

**`searchUrls` is a full-table scan**

`services/url-service/src/db.js`: `WHERE slug LIKE '%q%' OR long_url LIKE '%q%'`. Leading wildcards prevent index use. On a large table this degrades to O(n). For production use, a fulltext index or external search is needed.

**No URL update endpoint**

There is no `PUT /urls/:slug`. To change a destination URL, users must delete and recreate (losing the slug if it was custom, and losing click history).

**Duplicate inline admin auth** (same pattern as auth-service — see §4.1).

### 4.3 redirect-service

**Event buffer lost on crash**

`services/redirect-service/src/index.js:130-165`: `eventBuffer` is a module-level array. On process crash (OOM, SIGKILL from Docker during rebuild), buffered events are lost. This is documented in `ARCHITECTURE.md` as an intentional at-most-once tradeoff, but there is a secondary issue: multiple replicas each buffer independently, so events are never pooled. Graceful shutdown does flush the buffer, which partially mitigates this.

**`GET /` XSS** — see §3.3.

**Reserved-slug shadowing** — see §3.2.

**No rate limiting on `GET /:slug`**

The public redirect endpoint has no rate limiting. A crawler or bot can enumerate slugs at full speed. For a public-facing service, adding a lightweight rate limiter (e.g., 200 req/s per IP) would protect against abuse.

### 4.4 admin-service

**Double (and triple) validation per dashboard request**

`services/admin-service/src/index.js:67-101` validates the API key once in `validateAdminKey` middleware, then forwards the raw `X-API-Key` header to both auth-service `/admin/stats` and url-service `/admin/stats`, each of which validates again inline:

- `GET /admin/dashboard` → 1 validation in middleware + 1 in auth `/admin/stats` + 1 in url `/admin/stats` = **3 auth-service roundtrips per request** (plus the two Prometheus stats calls).

This multiplies auth-service load. The fix is either to use `X-Service-Token` for service-to-service admin calls (as is already done for analytics and config), or to expose dedicated endpoints that accept the service token.

**Dashboard cache is not invalidated**

`services/admin-service/src/index.js:119-122`: 10-second in-process cache. In a multi-replica deployment, each replica has an independent cache, and a new replica comes up cold. This is fine, but deleting a URL or revoking a key won't be reflected for up to 10 seconds. The cache provides no `cache-control` or `etag` to let callers know they're getting a stale response.

**No unit tests, no test script**

CI matrix (`services.yml`) marks `admin-service` with `has_tests: false`. There is no `vitest.config.js` in the service directory.

### 4.5 config-service

**Non-constant-time token compare** — see §3.5.

**Swagger API path differs between dev and prod**

`services/config-service/src/server.ts:202-207`:

```ts
apis: [
  isDev
    ? path.join(__dirname, '../src/server.ts')
    : path.join(__dirname, '*.js'),
],
```

In production the compiled `.js` file is `dist/server.js`, and `__dirname` points to `dist/`. The glob `*.js` finds `dist/server.js`. In dev, `__dirname` is `src/` (because ts-node) and it looks for `../src/server.ts`. Any path mismatch (e.g., after a `tsc` output directory change) silently produces empty Swagger docs. A deterministic approach is to point at the compiled output only and accept that `swagger-jsdoc` requires a build step.

**`__resetConfigCache` leaks into production exports**

`server.ts:211`: `export function __resetConfigCache()` is a test helper exported from the production module. This is a minor smell; the function could be gated with `if (process.env.NODE_ENV !== 'production')`.

### 4.6 analytics-service

**Batch endpoint has no upper size bound**

`services/analytics-service/.../EventController.java`: `POST /events:batch` validates that the list is non-null and non-empty, but there is no maximum size check. A caller sending a 100,000-event batch could spike memory and potentially cause an OOM. Add a `@Max` or explicit size check returning 413.

**Unit tests cover only context loading**

`AnalyticsApplicationTests.java` is a single `contextLoads` test with the `ClickHouseRepository` mocked. No controller behavior, no repository query logic, and no filter chain is exercised by unit tests. The analytics pipeline is the most complex part of the system and has the weakest test coverage.

**Compiled artifacts tracked in git**

`services/analytics-service/target/` (JAR, `.class` files, surefire reports) is tracked in git. There is no `.gitignore` for this service (unlike all other services which have one). This bloats the repo by ~10 MB, pollutes `git status`, and risks stale compiled artifacts being shipped in a Docker build. Add `services/analytics-service/.gitignore` with `/target/`.

**`ClickHouseRepository` builds IN clause by streaming, not parameterized**

`getCounts` builds `IN (?,?,?)` by concatenating `?` placeholders and then adds positional parameters — this is safe (no injection), but the number of placeholders is unbounded. With 100,000 slugs this generates a massive prepared statement. Use batching or the same query-string-to-POST fix recommended for `syncClickCounts`.

### 4.7 admin-ui

**No structured logging, no Prometheus metrics**

`services/admin-ui/server.js`: All logging uses `console.log`. There is no pino, no `GET /metrics`, and no request duration tracking. The service is invisible to any log aggregator or Prometheus scraper. This is the single service that violates the observability contract documented in `ARCHITECTURE.md`.

**API key in `localStorage` with no CSP**

`services/admin-ui/app.js`: The API key is stored in `localStorage` and loaded on page mount. Without a Content Security Policy header, any XSS (even a third-party script injection or a future inline injection) can steal the key. Minimum viable fix: set `Content-Security-Policy: default-src 'self'` in `server.js`.

**No `admin-ui` entry in `BASE` in test helpers**

`tests/integration/helpers.js` defines a `BASE` object with service URLs but the m6 admin-ui integration tests fall back to the hardcoded string `http://localhost:3004`. If the admin-ui port ever changes, the test silently still points to the old port.

---

## 5. Cross-Cutting Concerns

### 5.1 Testing

**Strengths:**
- Unit tests exist for all pure utility functions (auth, url, redirect, config) — this is the right scope for unit tests in a microservices system
- Integration test milestones are logically organized (M1 happy-path → M2 auth → M3 analytics → M4 observability → M5 config → M6 admin-ui)
- `vitest.config.js` per service keeps test scope isolated
- CI runs both unit tests and full integration suite with a live compose stack

**Gaps:**

*Hardcoded database password in test helpers* (`tests/integration/helpers.js`): The `resetDb` function connects to MySQL using a hardcoded password `urlpass` instead of `process.env.URL_DB_PASSWORD`. If the stack is started with a different password (or the `.env` file changes), the test helper silently fails to truncate the URL table, causing test pollution between runs.

*analytics-service test coverage* is effectively zero for business logic. `AnalyticsApplicationTests.java` proves Spring context starts — it does not test `insertBatch`, the `getCounts` IN clause, the materialized view rollup, or any filter behavior.

*admin-service has no tests at all.* The aggregation logic, degraded-mode behavior, caching, and proxy header forwarding are entirely untested.

*Rate-limit integration tests require a separate compose override.* Running `npm run test:e2e:rate` starts a fresh stack. There is no way to run rate-limit tests against the already-running dev stack without manual override. The two compose files diverge; any service change requires updating both.

### 5.2 CI/CD

**Strengths:**
- Four separate workflows with path filters to avoid unnecessary builds
- Node services CI: `npm ci` → unit tests → syntax check → Docker build → health smoke test
- analytics-service CI: `mvn verify` → Docker build
- Integration CI: compose up → full test suite → compose down (with log capture on failure)
- `fail-fast: false` on the Node matrix allows independent service failures to be visible separately

**Gaps:**

*No CI for rate-limit tests.* The `test:e2e:rate` script exists but no workflow runs it. Rate-limiting bugs would only be caught locally.

*config-service is the only service with a registry push.* `.github/workflows/config-service.yml` runs `npm test` → Docker build → `docker push ghcr.io/pxl-digital-application-samples/microshort-config-service:latest`. No other service workflow pushes an image. This means only config-service has a reproducible artifact trail in GHCR; all other services must be rebuilt from source on every deployment.

*No Docker image push.* Workflows build images but do not push to a registry. There is no artifact for deployment; every deploy requires a rebuild from source. This is fine for a development stack but would be a gap for staging/production.

### 5.3 Observability

**Strengths:**
- Uniform Prometheus metric naming convention (`microshort_<service>_` prefix)
- Default metrics + custom domain metrics on every Node service and Spring Actuator on analytics
- X-Request-ID generated at entry point (redirect/url/auth/config) and propagated through all service hops
- Pino structured JSON logging (ECS format on analytics) — compatible with Elastic and most log aggregators
- `/health` (liveness) and `/ready` (readiness) correctly separated on all services

**Gaps:**

*admin-ui breaks the contract.* No metrics, no structured logging, no request IDs. See §4.7.

*`/metrics` endpoints are unauthenticated on all services.* Metrics can leak internal state (queue depths, error rates, user/URL counts). In a public deployment, Prometheus scrape should be on a separate internal port or behind basic auth.

*No dashboards or alerting rules are checked in.* Prometheus metrics are emitted but there are no `grafana/` dashboards or `alertmanager/` rules in the repo. Operators have to build these from scratch.

*analytics-service `readiness` checks the ClickHouse connection* (correct), but there is no readiness check that verifies the materialized view is healthy or has recent data. A stale MV would show zero counts with no observable signal other than metric gaps.

### 5.4 Security Posture

*No HTTPS enforcement in config-service domain validation.* The AJV schema validates `uri` format, which allows `http://`. Setting `domain` to an `http://` address means all generated short URLs reference an insecure base. The schema should require `https:` in non-dev environments.

*One shared `SERVICE_TOKEN` for all service-to-service calls.* Documented in `ARCHITECTURE.md` as an intentional simplification. In a production multi-tenant scenario, each service pair should have its own secret so compromise of one token doesn't allow impersonation of all internal services. The fix is one env var per service-pair relationship.

*`npm config set strict-ssl false` in every Node Dockerfile.* This disables TLS certificate verification during `npm install`. This is a documented corporate proxy workaround (see memory), but it means every Docker build silently trusts any MITM-ed certificate for the npm registry. Where possible, install the corporate CA certificate instead (`RUN apt-get install ca-certificates && update-ca-certificates`).

### 5.5 Operational

*No `PLANNING.md` exists.* The git log references `docs: update PLANNING.md M5 status` but the file is not present in the current tree. Any milestone planning is implicit.

*No `PUT /urls/:slug` (update).* Users who want to change a long URL must delete and recreate, losing the short URL slug and all click history if the slug was not custom. This is a frequently needed operation.

*`checkHealth` in auth/url services uses `console.error` instead of the pino logger* on error (auth: `src/db.js:99`, url: would be analogous). Unhealthy DB connections are invisible to log aggregators.

*The admin-service `/admin/users/:userId` route returns a hardcoded 501* with a note about M7. This is a reasonable stub, but the endpoint is registered and callable — callers that error-check status codes will get a 501 rather than a 404, which implies the resource exists but the operation is unimplemented, which is correct.

---

## 6. Intentional Tradeoffs

The following are not bugs — they are documented design decisions in `ARCHITECTURE.md`. They are listed here for completeness so the findings table is not misread.

| Tradeoff | Where documented | Impact |
|---|---|---|
| At-most-once analytics (events lost on crash) | ARCHITECTURE.md §Analytics pipeline | Lost click counts during crash/deploy |
| 302 redirect + no-store to preserve analytics | ARCHITECTURE.md §302 vs 301 | No browser/CDN caching of redirects |
| Shared `SERVICE_TOKEN` across all internal service calls | ARCHITECTURE.md §Secrets | Single token compromise affects all service-to-service auth |
| `PUT /config/domain` is ephemeral (resets on restart) | ARCHITECTURE.md, config-service docs | Domain change does not survive service restart |
| Single Spring Boot service for analytics | ARCHITECTURE.md §Why Spring Boot | Polyglot overhead (JVM startup, separate CI) |
| Redis for both rate-limiting and slug caching | ARCHITECTURE.md §Redis namespaces | `FLUSHALL` in tests clears both |
| SHA-256 IP hashing (not bcrypt) for analytics | ARCHITECTURE.md §Privacy | Deterministic — same IP always produces same hash |
| `syncClickCounts` eventual consistency (60s default) | ARCHITECTURE.md §CQRS | Click counts in URL list are up to 60s stale |
| Module-level domain cache (1 min TTL) | Code comment in url-service | Domain updates don't propagate instantly to URL responses |

---

## 7. Prioritized Findings Table

| # | Severity | Service | Finding | File:Line | Fix Effort |
|---|---|---|---|---|---|
| 1 | **Medium** | url-service + redirect-service | URL scheme not allowlisted: `javascript:`/`data:` URIs stored and served to non-browser clients | `url-service/src/index.js:192` | 2 lines |
| 2 | **Medium** | redirect-service + url-service | Reserved slug shadowing: "health", "ready", "metrics" slugs silently unreachable | `redirect-service/src/index.js:172`, `url-service/src/utils.js:4` | RESERVED_SLUGS set in validator |
| 3 | **Medium** | auth-service + url-service | Rate limiters fail-open: `passOnStoreError: true` silently bypasses auth brute-force protection when Redis is down | `auth-service/src/index.js:91`, `url-service/src/index.js:95` | Log/metric the bypass; operational decision |
| 4 | **Medium** | analytics-service | Compiled `target/` directory tracked in git; no `.gitignore` | `services/analytics-service/` | Add `.gitignore` |
| 5 | **Medium** | auth-service/db.js | First-user admin race: COUNT(*)→INSERT not atomic | `auth-service/src/db.js:19-20` | Single atomic INSERT…SELECT |
| 6 | **Medium** | redirect-service | XSS in root page: domain value interpolated into HTML unescaped | `redirect-service/src/index.js:214` | HTML escape + CSP header |
| 7 | **Medium** | url-service | `syncClickCounts` query string unbounded; breaks at scale | `url-service/src/index.js:393-404` | POST body or paginate |
| 8 | **Medium** | tests | Hardcoded MySQL password `urlpass` in test helper | `tests/integration/helpers.js:15` | Use `process.env.URL_DB_PASSWORD` |
| 9 | **Medium** | admin-service | Triple API-key validation per dashboard request (3 auth roundtrips) | `admin-service/src/index.js:148-165` | Use `X-Service-Token` for service calls |
| 10 | **Medium** | auth-service + url-service | Duplicate inline admin auth logic (3 copies, not using middleware) | `auth/src/index.js:200,222`, `url/src/index.js:300,349` | Extract to middleware |
| 11 | **Low** | analytics-service | No max batch size check on `POST /events:batch` | `EventController.java` | `@Max(1000)` annotation |
| 12 | **Low** | config-service + analytics-service | Non-constant-time `X-Service-Token` comparison | `config-service/src/server.ts:134`, `ServiceTokenFilter.java:25` | `crypto.timingSafeEqual` / HMAC compare |
| 13 | **Low** | auth-service/utils.js | `isValidApiKeyFormat` exported and tested but never called on the hot path | `auth-service/src/utils.js:8` | Call before DB lookup |
| 14 | **Low** | auth-service | `getAllUsers` has no LIMIT | `auth-service/src/db.js:104` | `LIMIT 1000` + pagination |
| 15 | **Low** | url-service | `getAllUrls` LIMIT 1000 with no pagination cursor | `url-service/src/db.js` | Cursor-based pagination |
| 16 | **Low** | url-service | `searchUrls` full-table scan (leading `%` wildcard) | `url-service/src/db.js` | Fulltext index or search service |
| 17 | **Low** | admin-ui | No structured logging, no Prometheus metrics | `admin-ui/server.js` | Add pino + prom-client |
| 18 | **Low** | admin-ui | `express.static(__dirname)` serves `server.js` source | `admin-ui/server.js:12` | Restrict static root |
| 19 | **Low** | admin-ui | API key in `localStorage` without CSP | `admin-ui/app.js`, `admin-ui/server.js` | `Content-Security-Policy` header |
| 20 | **Low** | auth-service | `last_used_at` error logged via `console.error` not pino | `auth-service/src/db.js:66` | Use logger instance |
| 21 | **Low** | CI | Rate-limit integration tests not run in any CI workflow | `.github/workflows/` | Add workflow step or job |
| 22 | **Info** | auth-service | JWT role is mutable; revoked admin role valid for up to 7d | `auth-service/src/index.js:145` | Short JWT TTL or add revocation |
| 23 | **Info** | all services | Wildcard CORS (`cors()` unconfigured) | `auth/url/admin src/index.js` | Restrict to known origins |
| 24 | **Info** | all Node Dockerfiles | `npm config set strict-ssl false` disables TLS cert verification at build time | All `Dockerfile`s | Install corporate CA cert instead |

---

*End of review.*
