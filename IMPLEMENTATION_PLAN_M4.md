# IMPLEMENTATION PLAN — M4: Observability, Monitoring & Shared State

> **Status**: Not started  
> **Prerequisite**: M3 complete (analytics-service live on Java/Spring Boot + ClickHouse; all integration tests green)  
> **Source of truth for scope**: PLANNING.md §5 and §8.2; CODE_REVIEW.md findings CR 6.2, 6.3, 6.7, §8.2

---

## 0. Scope, Findings, and Locked Decisions

### 0.1 What M4 fixes

| Finding | Description | Workstream |
|---------|-------------|------------|
| CR 6.2  | `/health` is liveness-only; `checkHealth()` exists in auth/url db.js but wired to no route | C |
| CR 6.3  | No service handles SIGTERM; in-flight requests are dropped on restart | F |
| CR 6.7  | No structured logging, no `/metrics`, no request IDs, no cross-service tracing | D, E |
| CR §8.2 | Redirect-service uses per-instance in-memory Map cache; shared Redis cache planned | B |
| CR 4.3  | Per-call timeouts on admin upstream calls — **already done in M1/M3** (AbortSignal.timeout present throughout admin-service) | — |

### 0.2 Locked design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Redis client | **ioredis** (latest stable v5.x) | Most common in Node teaching contexts; ~4.5M weekly downloads; simpler API than node-redis v6 |
| Logging | **pino v9 + pino-http v10** | JSON by default; `req.log` child logger per request; ships its own TypeScript types |
| Prometheus client | **prom-client** (latest stable) | De facto standard for Node; supports `collectDefaultMetrics()` for runtime metrics |
| Rate-limit store | **rate-limit-redis v5** | Wraps existing express-rate-limit v8 instances (already in auth/url) with no API change |
| Admin degradation | **Partial results + `degraded` array** | Dashboard stays usable when analytics-service is down; `degraded: ['analytics']` signals the UI |
| Redirect `/ready` semantics | **Always 200** | Redirect-service is stateless; Redis is an optional cache with origin fallback — Redis down ≠ unready |

### 0.3 analytics-service observability scope

analytics-service (Spring Boot) already satisfies M4 health/metrics goals via Actuator (liveness, readiness, Prometheus — shipped in M3). Its remaining M4 obligation is:

- Structured JSON logging format
- Propagate and log `X-Request-ID` from incoming requests

This is workstream I, scoped to two small files.

### 0.4 Service capability matrix

What each service gains in M4 (✓ = added by M4, ✗ = unchanged, — = not applicable):

| Service | Language | `/ready` | pino logging | `/metrics` | SIGTERM | Redis | Notes |
|---------|----------|----------|--------------|------------|---------|-------|-------|
| auth-service | Node/JS | ✓ wires `checkHealth()` | ✓ | ✓ | ✓ | ✓ ioredis (rate-limit store) | |
| url-service | Node/JS | ✓ wires `checkHealth()` | ✓ | ✓ | ✓ | ✓ ioredis (rate-limit store) | |
| redirect-service | Node/JS | ✓ always 200 (stateless) | ✓ | ✓ cache hit/miss counters | ✓ | ✓ ioredis (primary cache) | eviction loop removed; Redis TTL replaces it |
| admin-service | Node/JS | ✓ always 200 (no DB) | ✓ | ✓ | ✓ | ✗ | dashboard cache is in-process (no Redis needed) |
| config-service | Node/TS | ✓ calls `loadConfig()` | ✓ | ✓ | ✓ | ✗ | |
| admin-ui | Node/JS | ✓ always 200 (static) | ✗ console.log kept | ✗ | ✓ SIGTERM only | ✗ | minimal service; pino/metrics overhead not warranted |
| analytics-service | Java | — already via Actuator | ✓ ECS JSON + MDC filter | — already via Micrometer | — already via Spring | — | only gains correlation ID propagation |

---

## 1. Current-State Facts

### 1.1 auth-service (`services/auth-service/src/`)

- `index.js` line 1: `app.listen(PORT, ...)` return value **not captured** → SIGTERM kills in-flight requests
- `index.js` lines 23-29: `express-rate-limit` v8 with **in-memory MemoryStore** → per-instance, not shared
- `index.js` line 84: `GET /health` → `200 OK`, no DB check
- No `/ready` route; no pino; no `/metrics`
- `db.js` last lines: `export async function checkHealth() { await sql\`SELECT 1\`; return true; }` — exported but **wired to no route**

### 1.2 url-service (`services/url-service/src/`)

- `index.js` line 305: `app.listen(PORT, ...)` **not captured**
- `index.js` lines 23-29: `express-rate-limit` v8 with **in-memory MemoryStore**
- `index.js` line 303: `setInterval(syncClickCounts, CLICK_SYNC_INTERVAL_MS)` — timer handle **not saved**, cannot be cleared on shutdown
- `index.js` line 84: `GET /health` → `200 OK`, no DB check
- No `/ready`; no pino; no `/metrics`
- `db.js` last lines: `export async function checkHealth() { await pool.execute('SELECT 1'); return true; }` — exported but **wired to no route**

### 1.3 redirect-service (`services/redirect-service/src/index.js`)

- Line 177: `app.listen(PORT, ...)` **not captured**
- Lines 21-22: `const cache = new Map(); const CACHE_TTL = 300000;` — **per-instance in-memory cache** (CR §8.2)
- Line 90: `setInterval(flushEvents, ANALYTICS_FLUSH_MS)` — timer handle not saved
- Lines 168-175: `setInterval(() => { /* eviction loop */ }, 60000)` — handle not saved
- Line 93: `GET /health` → `200 OK`
- No `/ready`; no pino; no `/metrics`

### 1.4 admin-service (`services/admin-service/src/index.js`)

- Line 284: `app.listen(PORT, ...)` **not captured**
- Lines 59-76: `Promise.all([4 upstream fetches])` — each already has `AbortSignal.timeout(2000)` (CR 4.3 resolved)
- Line 78-80: **All-or-nothing check** — if any upstream `!ok`, throws 500
- No dashboard response caching
- No `/ready`; no pino; no `/metrics`; no SIGTERM

### 1.5 config-service (`services/config-service/src/`)

- `index.ts` lines 1-4: `import app from './server'; app.listen(PORT, ...)` — **not captured**
- `server.ts`: no `/ready`; no pino; no `/metrics`; `loadConfig()` exported and could be called by `/ready`
- TypeScript project with build step (`tsc → dist/`); tests via vitest

### 1.6 admin-ui (`services/admin-ui/server.js`)

- Line 17: `app.listen(PORT, ...)` **not captured**
- Has `GET /health` — returns `200 OK`
- No `/ready`; no pino; no `/metrics`; no SIGTERM

### 1.7 analytics-service (`services/analytics-service/`)

- Spring Boot Actuator provides `/actuator/health/liveness`, `/actuator/health/readiness`, `/actuator/prometheus` (M3 complete)
- **No structured JSON logging** — default Logback text format
- **No X-Request-ID propagation** — correlation IDs not extracted or logged

### 1.8 Compose files

- `compose.yml`: healthchecks on all services use `GET /health` (liveness) for `service_healthy` gate
- No Redis container in either compose file
- Auth/url services have `depends_on` on their respective DBs; redirect depends on url/config; admin depends on auth/url/config/analytics

---

## 2. Workstreams

---

### Workstream A — Redis Infrastructure

**Files affected:**
- `compose.yml`
- `compose-simple.yml`
- `services/redirect-service/package.json`
- `services/auth-service/package.json`
- `services/url-service/package.json`

#### A.1 Add Redis container to `compose.yml`

Add the following service block (before the `volumes:` key):

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - microshort-network
```

Add `redis-data:` under the top-level `volumes:` block.

Update `redirect-service` `depends_on` to include:
```yaml
    depends_on:
      redis:
        condition: service_healthy
      url-service:
        condition: service_healthy
      config-service:
        condition: service_healthy
```

Update `auth-service` and `url-service` `depends_on` to include:
```yaml
      redis:
        condition: service_healthy
```

Add `REDIS_URL: redis://redis:6379` to `environment:` blocks for `redirect-service`, `auth-service`, and `url-service`.

#### A.2 Add Redis to `compose-simple.yml`

Same Redis service block but without the `healthcheck:` stanza (matches compose-simple.yml's lighter pattern). Use `depends_on: [redis]` for redirect, auth, url.

#### A.3 Install dependencies

```bash
cd services/redirect-service && npm install ioredis
cd services/auth-service     && npm install ioredis rate-limit-redis
cd services/url-service      && npm install ioredis rate-limit-redis
```

Commit updated `package.json` and `package-lock.json` for all three services.

> **Corporate SSL proxy**: Each service's Dockerfile already has `npm config set strict-ssl false` before `npm ci`. The `npm install` above is for local dev only; Docker builds use `npm ci` from the committed lockfile.

**Verify step:** `docker compose up -d redis` → `docker compose exec redis redis-cli ping` → `PONG`.

---

### Workstream B — Redirect-service Redis Cache

**Files affected:**
- `services/redirect-service/src/index.js` (major rewrite of cache logic)

#### B.1 Add ioredis client and replace Map cache

At the top of `index.js`, remove the `Map` cache and add a Redis client:

```js
// Remove these lines:
// const cache = new Map();
// const CACHE_TTL = 300000;
// const MAX_CACHE_SIZE = 10000;

import Redis from 'ioredis';

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS ?? '300');

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000
});

redis.on('error', err => logger.error({ err }, 'Redis error'));
```

`lazyConnect: true` — delays connection until first use; `enableOfflineQueue: false` — fail fast rather than queue commands when Redis is unreachable.

#### B.2 Rewrite `getRedirectUrl`

```js
async function getRedirectUrl(slug, reqLog) {
  const key = `slug:${slug}`;

  // Try Redis cache
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      cacheHits.inc();                            // see Workstream E
      reqLog.debug({ slug }, 'Cache hit (Redis)');
      return cached;
    }
  } catch (err) {
    reqLog.warn({ err }, 'Redis unavailable — falling through to url-service');
  }

  cacheMisses.inc();

  // Fetch from url-service
  try {
    const response = await fetch(`${URL_SERVICE_URL}/urls/${slug}`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return null;
    const data = await response.json();

    // Populate cache (best-effort; don't block redirect on failure)
    redis.set(key, data.longUrl, 'EX', CACHE_TTL_SECONDS).catch(
      err => reqLog.warn({ err }, 'Failed to write cache to Redis')
    );

    return data.longUrl;
  } catch (err) {
    reqLog.error({ err }, 'Error fetching URL from url-service');
    return null;
  }
}
```

Key behaviours:
- Redis miss or error → fall through to url-service (never blocks traffic)
- `redis.set(..., 'EX', seconds)` — TTL enforced server-side; no eviction loop needed for TTL
- Remove the old 60-second `setInterval` cache eviction loop entirely

Update all call sites of `getRedirectUrl(slug)` to pass `req.log` (added in Workstream D):

```js
const redirectUrl = await getRedirectUrl(slug, req.log);
```

#### B.3 Update `/ready` (stateless service — always 200)

```js
app.get('/ready', (req, res) => {
  res.json({ status: 'ready' });
});
```

> **Design rationale**: Redis is an optional performance cache. If Redis is down, redirects still work via url-service fallback. Therefore `/ready` reflects the service's own readiness (always true), not its optional cache layer. This is a meaningful teaching contrast with auth/url-service `/ready` which DO gate on their primary datastore.

**Verify steps:**
1. `curl http://localhost:8080/ready` → `{"status":"ready"}`
2. `docker compose stop redis && curl http://localhost:8080/abc123` — redirect still works
3. `docker compose start redis` — cache resumes

---

### Workstream C — Liveness/Readiness Split

**Files affected:**
- `services/auth-service/src/index.js`
- `services/url-service/src/index.js`
- `services/config-service/src/server.ts`
- `services/admin-service/src/index.js`
- `services/admin-ui/server.js`
- `compose.yml` (healthcheck URLs)

#### C.1 auth-service — wire `checkHealth()` to `/ready`

In `services/auth-service/src/index.js`, add after the existing `GET /health` route:

```js
import { checkHealth } from './db.js';    // already exported; add to existing import

app.get('/ready', async (req, res) => {
  const ok = await checkHealth();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});
```

#### C.2 url-service — wire `checkHealth()` to `/ready`

Same pattern in `services/url-service/src/index.js`:

```js
import { checkHealth, ..., pool } from './db.js';   // add checkHealth to existing import

app.get('/ready', async (req, res) => {
  const ok = await checkHealth();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable' });
});
```

#### C.3 config-service — check config.json readability

In `services/config-service/src/server.ts`, add after the existing `/health` route:

```ts
app.get('/ready', async (req: Request, res: Response) => {
  try {
    await loadConfig();           // loadConfig() already declared in this file (line ~27)
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', detail: (err as Error).message });
  }
});
```

#### C.4 admin-service — stateless, always ready

In `services/admin-service/src/index.js`, add:

```js
app.get('/ready', (req, res) => res.json({ status: 'ready' }));
```

#### C.5 admin-ui — stateless, always ready

In `services/admin-ui/server.js`, add before the `app.get('*', ...)` catch-all:

```js
app.get('/ready', (_req, res) => res.status(200).send('OK'));
```

#### C.6 Update compose.yml healthchecks

For all services, update the healthcheck `test` command from `/health` to `/ready`. This ensures `service_healthy` gates on true readiness, not just process liveness.

Example (auth-service):
```yaml
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/ready"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s
```

Apply the same pattern to url-service (port 3002), redirect-service (port 8080), admin-service (port 3003), config-service (port 3000), admin-ui (port 3004).

**Verify steps:**
1. `docker compose up -d` — watch `docker compose ps` until all show `(healthy)`
2. `curl http://localhost:3001/ready` → `{"status":"ready"}`
3. `docker compose stop auth-postgres && curl http://localhost:3001/ready` → `503 {"status":"unavailable"}`

---

### Workstream D — Structured Logging + Correlation ID

**Files affected:**
- `services/auth-service/src/index.js`
- `services/url-service/src/index.js`
- `services/redirect-service/src/index.js`
- `services/admin-service/src/index.js`
- `services/config-service/src/server.ts` + `package.json`
- `services/admin-ui/server.js`
- `services/analytics-service/src/main/resources/application.properties`
- `services/analytics-service/src/main/java/.../filter/CorrelationIdFilter.java` (new)

#### D.1 Install pino in Node services

Each of the five Node service directories (`auth-service`, `url-service`, `redirect-service`, `admin-service`, `admin-ui`):

```bash
npm install pino pino-http
```

For config-service (TypeScript — pino v9 ships its own `.d.ts`):

```bash
npm install pino pino-http
```

No `@types/pino` needed — pino v9+ includes TypeScript types.

Add to each service's `package.json` `dependencies`: `"pino": "^9.0.0"`, `"pino-http": "^10.0.0"`.

#### D.2 Logging setup for all Node services

Add to the top of each `index.js` / `index.ts`:

```js
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
```

Add pino-http middleware **as the first `app.use` call** (before CORS, body-parser, etc.):

```js
app.use(pinoHttp({
  logger,
  genReqId: req => req.headers['x-request-id'] ?? randomUUID(),
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: { ignore: req => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' }
}));

// pino-http does NOT echo the request ID as a response header by default.
// Add explicit middleware immediately after pino-http to propagate it:
app.use((req, res, next) => {
  res.setHeader('X-Request-ID', req.id);
  next();
});
```

`genReqId`: reads `X-Request-ID` from incoming request; generates a new UUID if absent. pino-http attaches the ID to all log lines as `reqId`. The explicit `res.setHeader` above (not pino-http's built-in) is what makes the DoD acceptance test and J.1 assertion pass.

Replace all `console.log` / `console.error` with pino equivalents:

| Before | After |
|--------|-------|
| `console.log('...')` | `logger.info('...')` |
| `console.error('msg:', err)` | `logger.error({ err }, 'msg')` (structured object first) |
| `console.error('msg:', err)` inside route handlers | `req.log.error({ err }, 'msg')` |

#### D.3 Propagate X-Request-ID on inter-service calls

Wherever a route handler makes an upstream `fetch()`, forward the correlation ID:

```js
// Before:
fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey }),
  signal: AbortSignal.timeout(2000)
});

// After:
fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-request-id': req.id },
  body: JSON.stringify({ apiKey }),
  signal: AbortSignal.timeout(2000)
});
```

Apply this to every `fetch()` call that receives a `req` object in scope:
- All route handlers in auth-service, url-service, admin-service
- The `/:slug` redirect handler in redirect-service (pass `req.id` into `getRedirectUrl`)

#### D.4 Background timer jobs — use job-scoped IDs (NOT request IDs)

`flushEvents` (redirect-service) and `syncClickCounts` (url-service) run on `setInterval`, detached from any HTTP request. There is no `req.id` available. Use a job-scoped ID instead:

```js
// redirect-service — flushEvents
async function flushEvents() {
  if (eventBuffer.length === 0) return;
  const jobId = randomUUID();
  const batch = eventBuffer.splice(0);
  logger.info({ job: 'analytics-flush', jobId, batchSize: batch.length }, 'Flushing analytics events');
  try {
    await fetch(`${ANALYTICS_SERVICE_URL}/events:batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': SERVICE_TOKEN,
        'x-request-id': jobId              // job-scoped, not request-scoped
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000)
    });
    logger.info({ job: 'analytics-flush', jobId }, 'Flush complete');
  } catch (err) {
    logger.error({ job: 'analytics-flush', jobId, err }, 'Analytics flush failed');
  }
}
```

```js
// url-service — syncClickCounts
async function syncClickCounts() {
  const jobId = randomUUID();
  logger.info({ job: 'click-sync', jobId }, 'Starting click count sync');
  try {
    // ... existing logic ...
    logger.info({ job: 'click-sync', jobId }, 'Click sync complete');
  } catch (err) {
    logger.error({ job: 'click-sync', jobId, err }, 'Click count sync failed');
  }
}
```

Note: `flushEvents` is changed from sync to `async`. The `setInterval(flushEvents, ...)` call still works — `setInterval` ignores the returned Promise. On shutdown, the final drain `await flushEvents()` waits for the fetch to complete.

#### D.5 config-service TypeScript — add pino to server.ts

```ts
import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

app.use(pinoHttp({
  logger,
  genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID()
}));
```

Replace `console.log`/`console.error` with `logger.info`/`logger.error` throughout `server.ts`.

#### D.6 analytics-service — structured JSON logging + X-Request-ID

**`services/analytics-service/src/main/resources/application.properties`** — add:

```properties
# Structured JSON logging (Spring Boot 3.4+)
logging.structured.format.console=ecs
```

For Spring Boot 3.3 and earlier, add Logback JSON encoder to `logback-spring.xml` instead (consult pom.xml Spring Boot version at implementation time).

**New file: `services/analytics-service/src/main/java/<base-package>/filter/CorrelationIdFilter.java`**

```java
package be.pxl.microshort.analytics.filter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

@Component
public class CorrelationIdFilter extends OncePerRequestFilter {

    private static final String HEADER  = "X-Request-ID";
    private static final String MDC_KEY = "request_id";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String id = request.getHeader(HEADER);
        if (id == null || id.isBlank()) id = UUID.randomUUID().toString();

        MDC.put(MDC_KEY, id);
        response.setHeader(HEADER, id);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
```

Spring's ECS structured logging automatically includes MDC fields in the JSON output. Every log line now carries `labels.request_id` when a request is in scope.

**Verify steps:**
1. Make a request to any service → response headers include `X-Request-ID`
2. `docker compose logs auth-service` — log lines are JSON with `reqId` field
3. `docker compose logs analytics-service` — log lines are JSON with `labels.request_id`

---

### Workstream E — Prometheus Metrics

**Files affected:**
- All five Node service `src/index.js` (and config-service `src/server.ts`)
- Each service's `package.json`

#### E.1 Install prom-client

```bash
# In each Node service directory:
npm install prom-client
```

Add `"prom-client": "^15.0.0"` to each `package.json` `dependencies`.

#### E.2 Common metrics setup pattern

Add to each service's index file (after pino setup, before route definitions):

```js
import promClient from 'prom-client';

// Collect Node.js runtime metrics (heap, GC, event loop lag, etc.)
const servicePrefix = 'microshort_auth_';   // adjust per service: auth_, url_, redirect_, admin_, config_
promClient.collectDefaultMetrics({ prefix: servicePrefix });

// HTTP request counter
const httpRequests = new promClient.Counter({
  name: `${servicePrefix}http_requests_total`,
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status']
});

// HTTP request duration histogram
const httpDuration = new promClient.Histogram({
  name: `${servicePrefix}http_request_duration_seconds`,
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
});
```

Add HTTP instrumentation middleware **after** pino-http, **before** route definitions:

```js
app.use((req, res, next) => {
  // Skip observability endpoints themselves to avoid noise
  if (['/health', '/ready', '/metrics'].includes(req.path)) return next();

  const end = httpDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    // req.route.path gives '/:slug' not '/abc123' — critical for cardinality control
    const route = req.route?.path ?? 'unknown';
    end({ route });
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});
```

> **Label cardinality warning**: Always use `req.route?.path` (the route pattern) not `req.path` (the actual URL). redirect-service handles `/:slug` — if `req.path` were used, every unique short URL would become a distinct label value and the metrics registry would grow unboundedly.

Add the `/metrics` endpoint (place it near `/health` and `/ready`):

```js
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});
```

#### E.3 Per-service custom metrics

**redirect-service** — cache counters (in addition to common metrics):

```js
const cacheHits = new promClient.Counter({
  name: 'microshort_redirect_cache_hits_total',
  help: 'Slug cache hits served from Redis'
});

const cacheMisses = new promClient.Counter({
  name: 'microshort_redirect_cache_misses_total',
  help: 'Slug cache misses (fetched from url-service)'
});
```

Increment `cacheHits.inc()` on Redis hit, `cacheMisses.inc()` on Redis miss in `getRedirectUrl`.

**auth-service** — API key validation counter:

```js
const apiKeyValidations = new promClient.Counter({
  name: 'microshort_auth_api_key_validations_total',
  help: 'API key validation results',
  labelNames: ['result']   // 'valid', 'invalid'
});
```

Increment on each `/auth/validate` response: `apiKeyValidations.inc({ result: authResult.valid ? 'valid' : 'invalid' })`.

**url-service** — URL creation counter:

```js
const urlCreations = new promClient.Counter({
  name: 'microshort_url_creations_total',
  help: 'Short URLs created',
  labelNames: ['type']    // 'auto' (nanoid), 'custom' (user-specified slug)
});
```

Increment in `POST /urls`: `urlCreations.inc({ type: customSlug ? 'custom' : 'auto' })`.

**analytics-service**: Spring Boot Actuator + Micrometer already exposes `/actuator/prometheus` with full JVM and HTTP metrics — no code changes needed for E.

**Verify steps:**
1. `curl http://localhost:3001/metrics | head -30` — shows `# HELP microshort_auth_` prefixed lines
2. Content-Type header is `text/plain; version=0.0.4; charset=utf-8`
3. Make several requests then check `microshort_auth_http_requests_total` counter incremented
4. `curl http://localhost:8080/abc123` twice → `microshort_redirect_cache_hits_total` shows 1 on second request

---

### Workstream F — Graceful SIGTERM Shutdown

**Files affected:**
- `services/auth-service/src/index.js`
- `services/url-service/src/index.js`
- `services/redirect-service/src/index.js`
- `services/admin-service/src/index.js`
- `services/config-service/src/index.ts`
- `services/admin-ui/server.js`

#### F.1 Common shutdown pattern

For every service, replace the bare `app.listen(...)` call with a captured `server` variable and attach signal handlers:

```js
// Remove:
app.listen(PORT, () => { console.log(...); });

// Replace with:
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Service started');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close(async () => {
    // Service-specific cleanup (see below)
    process.exit(0);
  });
  // Force-quit if graceful drain takes > 30 s
  setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

#### F.2 auth-service — close postgres.js pool

```js
server.close(async () => {
  await sql.end();     // postgres.js connection pool; 'sql' is the porsager postgres client
  logger.info('Auth service shut down cleanly');
  process.exit(0);
});
```

`sql` is already imported from `./db.js`. Confirm the export name by checking `services/auth-service/src/db.js`.

#### F.3 url-service — clear interval + close mysql2 pool

Save the interval handle at module level:

```js
// Remove:
setInterval(syncClickCounts, CLICK_SYNC_INTERVAL_MS);

// Replace with:
const syncIntervalId = setInterval(syncClickCounts, CLICK_SYNC_INTERVAL_MS);
```

In shutdown:

```js
server.close(async () => {
  clearInterval(syncIntervalId);
  await pool.end();    // mysql2 pool; already imported in the file
  logger.info('URL service shut down cleanly');
  process.exit(0);
});
```

#### F.4 redirect-service — clear both intervals + final analytics flush + quit Redis

Save both interval handles:

```js
// Remove:
setInterval(flushEvents, ANALYTICS_FLUSH_MS);
setInterval(() => { /* eviction */ }, 60000);

// Replace with:
const flushIntervalId  = setInterval(flushEvents, ANALYTICS_FLUSH_MS);
// Note: eviction loop removed entirely (Redis TTL handles expiry). 
// If Map fallback is kept for any reason, save: const evictIntervalId = setInterval(...)
```

In shutdown:

```js
server.close(async () => {
  clearInterval(flushIntervalId);
  await flushEvents();       // drain remaining events before exit (flushEvents is now async)
  await redis.quit();
  logger.info('Redirect service shut down cleanly');
  process.exit(0);
});
```

#### F.5 admin-service — no DB pool, just close server

```js
server.close(() => {
  logger.info('Admin service shut down cleanly');
  process.exit(0);
});
```

#### F.6 config-service — capture server in `index.ts`

`index.ts` currently: `app.listen(PORT, () => { ... })`. Change to:

```ts
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Config service started');
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(() => {
    logger.info('Config service shut down cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

#### F.7 admin-ui — same as admin-service (no DB pool)

```js
const server = app.listen(PORT, () => {
  console.log(`Admin UI running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
});
```

admin-ui has no pino (minimal service, no JSON logging needed for a static file server). Keep existing `console.log`.

**Verify steps:**
1. `docker compose kill -s SIGTERM auth-service` — service stops cleanly (exit code 0 in `docker compose ps`)
2. `docker compose logs auth-service | tail -5` — shows `"Shutdown signal received"` and `"shut down cleanly"`
3. Send a slow request to url-service while SIGTERMing it — in-flight request completes before shutdown

---

### Workstream G — Admin-service Resilient Dashboard

**Files affected:**
- `services/admin-service/src/index.js`

#### G.1 Replace all-or-nothing with partial results

Add module-level helpers and cache variables (after `const PORT = ...` declarations):

```js
// Short-lived in-process dashboard cache to absorb thundering herd
const DASHBOARD_CACHE_TTL = 10_000; // 10 seconds
let dashboardCache = null;
let dashboardCacheExpiry = 0;

// Fetch an upstream service, returning null (not throwing) on any failure
async function fetchUpstream(url, options, log) {
  try {
    const res = await fetch(url, { ...options });
    if (!res.ok) {
      log.warn({ url, status: res.status }, 'Upstream returned non-OK response');
      return null;
    }
    return res.json();
  } catch (err) {
    log.warn({ url, err: err.message }, 'Upstream fetch failed');
    return null;
  }
}
```

Replace the current `GET /admin/dashboard` handler (lines 57–105 in current `index.js`):

```js
app.get('/admin/dashboard', validateAdminKey, async (req, res) => {
  // Serve cached response if still fresh
  if (dashboardCache && Date.now() < dashboardCacheExpiry) {
    req.log.debug('Serving cached dashboard response');
    return res.json(dashboardCache);
  }

  const sharedHeaders = { 'x-request-id': req.id };

  const [authData, urlData, overviewData, topData] = await Promise.all([
    fetchUpstream(`${AUTH_SERVICE_URL}/admin/stats`, {
      headers: { 'X-API-Key': req.headers['x-api-key'], ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${URL_SERVICE_URL}/admin/stats`, {
      headers: { 'X-API-Key': req.headers['x-api-key'], ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${ANALYTICS_SERVICE_URL}/stats/overview`, {
      headers: { 'X-Service-Token': SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log),
    fetchUpstream(`${ANALYTICS_SERVICE_URL}/stats/top?limit=10`, {
      headers: { 'X-Service-Token': SERVICE_TOKEN, ...sharedHeaders },
      signal: AbortSignal.timeout(2000)
    }, req.log)
  ]);

  const degraded = [
    authData     === null && 'auth',
    urlData      === null && 'url',
    overviewData === null && 'analytics'
  ].filter(Boolean);

  const response = {
    ...(degraded.length > 0 && { degraded }),
    users: authData ? {
      total:         authData.totalUsers,
      recentSignups: authData.recentUsers,
      totalApiKeys:  authData.totalApiKeys
    } : null,
    urls: {
      total:       urlData?.totalUrls        ?? null,
      recentUrls:  urlData?.recentUrls       ?? null,
      totalClicks: overviewData?.totalClicks ?? null,
      topUrls:     topData?.map(t => ({ slug: t.slug, clicks: t.totalClicks })) ?? null
    }
  };

  // Update cache
  dashboardCache    = response;
  dashboardCacheExpiry = Date.now() + DASHBOARD_CACHE_TTL;

  if (degraded.length > 0) {
    req.log.warn({ degraded }, 'Dashboard response is partial');
  }

  res.json(response);
});
```

Key changes vs. current code:
1. All four `fetch()` calls go via `fetchUpstream()` which absorbs errors and returns `null`
2. Removed line 78-80: `if (!authStatsRes.ok || !urlStatsRes.ok || ...)` all-or-nothing check
3. `degraded` array signals which services are down — absent when all are healthy
4. 10-second in-process cache prevents downstream services from being hammered during high traffic or recovery

#### G.2 Forward X-Request-ID in all other admin-service routes

Apply the same `'x-request-id': req.id` header to the fetch calls in:
- `GET /admin/users`
- `GET /admin/urls`
- `PUT /admin/config` / `GET /admin/config`
- `GET /admin/search/urls`
- `GET /admin/health/services`

**Verify steps:**
1. With all services up: `curl /admin/dashboard` → no `degraded` field in response
2. `docker compose stop analytics-service && curl /admin/dashboard` → `{"degraded":["analytics"], "users":{...}, "urls":{...}}` — users and urls still populated
3. `docker compose start analytics-service` — next dashboard request after cache expiry is full again

---

### Workstream H — Shared Rate-Limit Store

**Files affected:**
- `services/auth-service/src/index.js`
- `services/url-service/src/index.js`

#### H.1 auth-service — wire rate limiter to Redis

auth-service has **one** rate limiter (`authLimiter`). Add Redis client and update it:

```js
import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1
});

redis.on('error', err => logger.error({ err }, 'Redis error'));

// Update existing authLimiter to use Redis:
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? String(15 * 60 * 1000)),
  limit:    parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,        // confirmed in express-rate-limit v8.5.2 type definitions
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-auth:'           // service-scoped prefix — avoids collision with url-service keys
  }),
  message: { error: 'Too many requests, please try again later' }
});
```

`passOnStoreError: true` — confirmed present in express-rate-limit v8.5.2 (`dist/index.d.ts`). If Redis is unavailable, rate limiting degrades to pass-through rather than blocking all traffic.

`prefix: 'rl-auth:'` — **critical**: auth-service and url-service share the same Redis instance. Without a service-scoped prefix, both write `rl:<ip>` and merge counters across services. auth uses `rl-auth:<ip>`, url uses `rl-url:<ip>`.

#### H.2 url-service — same pattern

url-service also has **one** rate limiter (`urlCreateLimiter`):

```js
import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1
});

redis.on('error', err => logger.error({ err }, 'Redis error'));

// Update existing urlCreateLimiter to use Redis:
const urlCreateLimiter = rateLimit({
  windowMs: parseInt(process.env.URL_RATE_LIMIT_WINDOW_MS ?? String(60 * 1000)),
  limit:    parseInt(process.env.URL_RATE_LIMIT_MAX ?? '30'),
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-url:'            // distinct from auth-service's 'rl-auth:' prefix
  }),
  message: { error: 'Too many requests, please try again later' }
});
```

Also add graceful shutdown for the Redis client in each service's `shutdown()` function (after closing the DB pool): `await redis.quit()`.

**Verify step:** Start two instances of url-service on different ports, create 30 URLs via one instance, then try `POST /urls` via the other — should be rate limited. (Requires manual compose override for testing; document in test notes.)

---

### Workstream I — analytics-service Structured Logging (Java)

Already covered in Workstream D.6. Summary:

1. **`application.properties`**: Add `logging.structured.format.console=ecs`
2. **`CorrelationIdFilter.java`**: New `@Component` filter extracting `X-Request-ID` into MDC as `request_id`

If the Spring Boot parent version in `pom.xml` is < 3.4, add the `logstash-logback-encoder` dependency and a `logback-spring.xml` with `LogstashEncoder` instead of the `application.properties` property.

**Verify:** `docker compose logs analytics-service | head -5` → JSON lines containing `request_id` field.

---

### Workstream J — Integration Tests

**Files affected:**
- `tests/m4.integration.test.js` (new file)
- `package.json` (root — add test:m4 script)

#### J.1 New test file: `tests/m4.integration.test.js`

```js
import { describe, it, expect } from 'vitest';

// All six Node services get /ready
const SERVICES_READY = [
  { name: 'auth',      port: 3001 },
  { name: 'url',       port: 3002 },
  { name: 'redirect',  port: 8080 },
  { name: 'admin',     port: 3003 },
  { name: 'config',    port: 3000 },
  { name: 'admin-ui',  port: 3004 },  // /ready returns text 'OK', not JSON
];

// admin-ui has no prom-client; analytics-service exposes /actuator/prometheus (not /metrics)
const SERVICES_METRICS = [
  { name: 'auth',     port: 3001 },
  { name: 'url',      port: 3002 },
  { name: 'redirect', port: 8080 },
  { name: 'admin',    port: 3003 },
  { name: 'config',   port: 3000 },
];

describe('M4 — Readiness endpoints', () => {
  for (const svc of SERVICES_READY) {
    it(`${svc.name}-service /ready returns 200`, async () => {
      const res = await fetch(`http://localhost:${svc.port}/ready`);
      expect(res.status).toBe(200);
    });
  }
});

describe('M4 — Prometheus metrics', () => {
  for (const svc of SERVICES_METRICS) {
    it(`${svc.name}-service /metrics returns valid Prometheus text`, async () => {
      const res = await fetch(`http://localhost:${svc.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toMatch(/^# HELP /m);
      expect(body).toMatch(/^# TYPE /m);
    });
  }
});

describe('M4 — X-Request-ID propagation', () => {
  it('echoes X-Request-ID header in auth-service response', async () => {
    const id = 'test-correlation-123';
    const res = await fetch('http://localhost:3001/health', {
      headers: { 'x-request-id': id }
    });
    expect(res.headers.get('x-request-id')).toBe(id);
  });

  it('generates X-Request-ID when absent', async () => {
    const res = await fetch('http://localhost:3001/health');
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);  // UUID format
  });
});

describe('M4 — Admin dashboard degradation', () => {
  it('returns full response when all services healthy', async () => {
    // Assumes API key in env (from existing integration test setup)
    const res = await fetch('http://localhost:3003/admin/dashboard', {
      headers: { 'X-API-Key': process.env.TEST_ADMIN_API_KEY }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBeUndefined();
    expect(body.users).not.toBeNull();
    expect(body.urls).toBeDefined();
  });

  it('dashboard cache: second call within TTL returns same response', async () => {
    const fetch1 = await (await fetch('http://localhost:3003/admin/dashboard', {
      headers: { 'X-API-Key': process.env.TEST_ADMIN_API_KEY }
    })).json();
    const fetch2 = await (await fetch('http://localhost:3003/admin/dashboard', {
      headers: { 'X-API-Key': process.env.TEST_ADMIN_API_KEY }
    })).json();
    expect(fetch1).toEqual(fetch2);
  });
});

describe('M4 — Redirect-service Redis cache', () => {
  it('redirect cache hit/miss metrics are non-zero after redirect', async () => {
    // First, resolve a known slug (creates cache entry)
    await fetch('http://localhost:8080/test-slug', { redirect: 'manual' });

    // Then check metrics
    const metrics = await (await fetch('http://localhost:8080/metrics')).text();
    expect(metrics).toMatch(/microshort_redirect_cache_misses_total \d/);
  });
});
```

#### J.2 Root `package.json` — add test script

```json
{
  "scripts": {
    "test:m4": "vitest run tests/m4.integration.test.js"
  }
}
```

---

## 3. File-Change Summary

| Service | File | Change type |
|---------|------|-------------|
| **All Node services** | `package.json` | Add `pino`, `pino-http`, `prom-client` |
| **auth-service** | `src/index.js` | Add pino, /ready, /metrics, SIGTERM, Redis rate-limiter |
| **auth-service** | `package.json` | Add `ioredis`, `rate-limit-redis` |
| **url-service** | `src/index.js` | Add pino, /ready, /metrics, SIGTERM, Redis rate-limiter, save interval handle |
| **url-service** | `package.json` | Add `ioredis`, `rate-limit-redis` |
| **redirect-service** | `src/index.js` | Replace Map cache with ioredis, add /ready, /metrics, pino, SIGTERM, save interval handles, make flushEvents async |
| **redirect-service** | `package.json` | Add `ioredis`, `pino`, `pino-http`, `prom-client` |
| **admin-service** | `src/index.js` | Add pino, /ready, /metrics, SIGTERM, replace all-or-nothing dashboard with partial results + 10s cache |
| **config-service** | `src/server.ts` | Add pino, /ready |
| **config-service** | `src/index.ts` | Capture server, add SIGTERM |
| **config-service** | `package.json` | Add `pino`, `pino-http`, `prom-client` |
| **admin-ui** | `server.js` | Add /ready, capture server, add SIGTERM |
| **analytics-service** | `src/main/resources/application.properties` | Add `logging.structured.format.console=ecs` |
| **analytics-service** | `src/main/java/.../filter/CorrelationIdFilter.java` | New: MDC filter for X-Request-ID |
| **root** | `compose.yml` | Add Redis service, update healthchecks to /ready, add REDIS_URL env vars, add redis-data volume |
| **root** | `compose-simple.yml` | Add Redis service (no healthcheck) |
| **root** | `tests/m4.integration.test.js` | New: M4 integration test suite |
| **root** | `package.json` | Add `test:m4` script |

---

## 4. Commit Sequence

Commits are ordered so each leaves the stack in a runnable, testable state.

```
1. chore(infra): add Redis 7 container to compose.yml and compose-simple.yml
   — Redis healthcheck, volume, env vars wired to redirect/auth/url

2. feat(all): add pino structured logging + X-Request-ID propagation
   — MUST come before redirect cache rewrite (commit 4 uses logger and req.log)
   — all Node services, including config-service (TypeScript); background jobs use job-scoped IDs
   — analytics-service gets CorrelationIdFilter + ECS log format

3. feat(all): add /ready readiness endpoints to all six Node services
   — auth/url wire existing checkHealth(); others return 200; compose healthchecks updated to /ready

4. feat(redirect): replace in-memory Map cache with Redis via ioredis
   — now safe: logger and metrics counters (from commits 2+5) already in place
   — getRedirectUrl tries Redis first; falls back to url-service; /ready always 200

5. feat(all): add Prometheus /metrics to all Node services via prom-client
   — default runtime metrics + HTTP counters/histograms; per-service custom counters
   — redirect cacheHits/cacheMisses counters referenced in commit 4 are defined here

6. feat(all): add graceful SIGTERM shutdown to all Node services
   — server = app.listen(); server.close() drains connections; clearInterval for timers

7. feat(admin): partial-results dashboard with degraded flag + 10s response cache
   — fetchUpstream absorbs errors; Promise.all with null-coalescing; degraded array

8. feat(auth,url): share rate-limit state via Redis (rate-limit-redis + ioredis)
   — passOnStoreError: true ensures graceful fallback when Redis unavailable

9. test: add M4 integration test suite (readiness, metrics, degradation, cache)
```

> **Implementation note for commit 4**: if commits 2 and 5 are in progress simultaneously, stub the metrics counters as no-ops (`const cacheHits = { inc: () => {} }`) in the redirect PR until prom-client is merged, then replace. The sequence above is the safe serial order.

---

## 5. Definition of Done

- [ ] `docker compose up -d` — all services show `(healthy)` in `docker compose ps` within 60 s
- [ ] `curl http://localhost:<port>/ready` returns `200 {"status":"ready"}` for all six Node services
- [ ] `curl http://localhost:3001/ready` after `docker compose stop auth-postgres` returns `503 {"status":"unavailable"}`
- [ ] `curl http://localhost:8080/metrics` returns `text/plain` Prometheus format with `# HELP microshort_redirect_` lines
- [ ] `docker compose logs auth-service | head -20` — all lines are valid JSON objects with `reqId` field
- [ ] `curl -H "X-Request-ID: abc" http://localhost:3001/health` — response header includes `x-request-id: abc`
- [ ] `docker compose logs analytics-service | head -5` — JSON lines with `labels.request_id`
- [ ] `docker compose stop analytics-service && curl /admin/dashboard` — returns `200` with `"degraded":["analytics"]` and non-null `users`
- [ ] `docker compose kill -s SIGTERM url-service && docker compose logs url-service | tail -3` — shows `"Shutdown signal received"` and clean exit
- [ ] `npm run test:m4` from root — all tests green against a running stack
- [ ] Rate-limiting: verify two different host IPs (via compose network) share the same limit counter (manual verify step)

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ioredis connection failure breaks redirect traffic | Low | High | `lazyConnect`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1` — Redis errors caught; fallback to url-service always runs |
| Rate-limiter Redis down blocks all POST /urls and /auth/login | Low | High | `passOnStoreError: true` on every `rateLimit()` instance — degrades to no rate limiting rather than hard failure |
| prom-client label cardinality explosion on redirect `/:slug` | Medium | High | `req.route?.path ?? 'unknown'` instead of `req.path` — route pattern captured, not slug value |
| analytics-service Spring Boot version < 3.4 (ECS format unavailable) | Unknown | Low | At implementation time, check `pom.xml` parent version; fall back to `logstash-logback-encoder` + `logback-spring.xml` |
| `flushEvents` now async — `setInterval` ignores returned Promise, errors swallowed | Low | Low | Errors are caught inside `flushEvents` and logged via `logger.error`; the function never throws |
| config-service TypeScript build breaks on pino types | Low | Low | pino v9+ ships its own `.d.ts`; no `@types/pino` needed; `pino-http` also ships types |
| Docker build fails due to SSL proxy (corporate environment) | Known | Medium | All Node Dockerfiles already have `npm config set strict-ssl false` before `npm ci`; lockfiles committed |
| Graceful drain + 30 s timeout hangs compose down | Low | Low | `setTimeout(...).unref()` — timer doesn't prevent process.exit; compose `stop_grace_period` should match |

---

## 7. Out of Scope for M4

| Item | Notes |
|------|-------|
| Prometheus scrape configuration / Grafana dashboards | M5 or separate infra work; `/metrics` endpoints are produced, not consumed, in M4 |
| Distributed tracing (Jaeger, OpenTelemetry spans) | Correlation ID (single string) is the M4 tracing primitive; full span propagation is future work |
| Config backing store (file → config-service DB) | PLANNING.md §5 marks this M5+ |
| Admin-service `/admin/users/:userId` (501 endpoint) | Still 501 after M4; needs auth/url admin endpoint additions — separate milestone |
| Redis authentication / TLS | Local dev; production hardening is out of scope for this teaching prototype |
| Kubernetes liveness/readiness probe declarations | compose.yml only; K8s manifests not in scope |
| analytics-service rate limiting | Analytics uses `X-Service-Token` for inter-service auth; no public rate limiting planned |
| per-request Redis cache invalidation on URL delete | `DELETE /urls/:slug` does not purge the Redis key in M4; TTL-based expiry (5 min) is sufficient for the teaching scope |
