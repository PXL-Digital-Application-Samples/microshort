# microshort — Implementation Plan

> Created: 2026-06-10  
> Based on: REVIEW.md (2026-06-10)  
> Scope: All 24 numbered findings + §5 cross-cutting gaps (dashboards excluded per discussion; §6 intentional tradeoffs not reversed)

---

## Dependency map

Some milestones must be sequenced. Everything else is independent.

```
M1 (quick wins)         → no deps, do first
M2 (URL/redirect sec)   → no deps
M3 (auth-service)       → no deps
M4 (inline auth + internal endpoints)  → M3 (requires requireAdmin middleware)
M5 (performance)        → M5.1 requires analytics-service POST endpoint (M5.1a before M5.1b)
M6 (rate-limiter obs)   → no deps
M7 (timing safe)        → no deps
M8 (CORS env var)       → no deps
M9 (admin-ui)           → no deps
M10 (JWT refresh)       → no deps
M11 (PUT /urls/:slug)   → no deps
M12 (per-service tokens)→ M4 must be done first (internal endpoints need their own token)
M13 (CI/CD)             → no deps
M14 (tests)             → M3, M4, M9 (tests for changed code)
```

---

## Milestone 1 — Quick Wins

These are mechanical, isolated changes. Do them first to clear the backlog.

### M1.1 — analytics-service `.gitignore` (Finding #4)

**Problem:** `services/analytics-service/target/` (~10 MB of compiled JARs and `.class` files) is tracked in git. No `.gitignore` exists for this service.

**Fix:**

Create `services/analytics-service/.gitignore`:
```
/target/
```

Then remove the tracked files:
```bash
git rm -r --cached services/analytics-service/target/
```

**Files:** `services/analytics-service/.gitignore` (new)  
**Tests:** none  
**Effort:** 5 min

---

### M1.2 — Hardcoded database password in test helpers (Finding #8)

**Problem:** `tests/integration/helpers.js:15` passes `-purlpass` (hardcoded) to `mysql` CLI. If `URL_DB_PASSWORD` in `.env` differs, `resetDb()` fails silently and tests pollute each other.

**Fix:** Replace the hardcoded password with an env-var lookup:

```js
// tests/integration/helpers.js
const URL_DB_PASS = process.env.URL_DB_PASSWORD ?? 'urlpass';

execSync(`docker compose exec -T url-db mysql -u urluser -p${URL_DB_PASS} -D urlshort -e "TRUNCATE TABLE urls;"`);
```

**Files:** `tests/integration/helpers.js:15`  
**Tests:** no new tests; existing integration suite validates this  
**Effort:** 5 min

---

### M1.3 — `console.error` → pino in `auth-service/db.js` (Finding #20)

**Problem:** `auth-service/src/db.js:66` uses `console.error` for the `last_used_at` fire-and-forget update failure. `auth-service/src/db.js:99` uses `console.error` for `checkHealth`. Both are invisible to JSON log aggregators.

**Fix:** Import the pino logger and replace both:

```js
// top of db.js — import the already-constructed logger
import logger from './logger.js'; // or however the logger is exported
```

```js
// line 66
sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyData.id}`
  .catch(err => logger.error({ err }, 'last_used_at update failed'));

// line 99
} catch (err) {
  logger.error({ err }, 'Database health check failed');
  return false;
}
```

> Note: confirm the logger export path — check how `index.js` constructs pino and whether it re-exports it.

**Files:** `services/auth-service/src/db.js:66,99`  
**Tests:** none  
**Effort:** 10 min

---

### M1.4 — `console.error` → pino in `url-service/db.js` (§5.5)

**Problem:** `url-service/src/db.js:73` uses `console.error` for `checkHealth`. Same issue as M1.3.

**Fix:** Same pattern — import the service logger, replace `console.error`.

**Files:** `services/url-service/src/db.js:73`  
**Effort:** 5 min

---

### M1.5 — `__resetConfigCache` production leak (§4.5)

**Problem:** `config-service/src/server.ts` exports `__resetConfigCache()` — a test helper — from the production module with no guard.

**Fix:** Gate with `NODE_ENV`:

```ts
// server.ts (near bottom)
export function __resetConfigCache(): void {
  if (process.env.NODE_ENV !== 'production') {
    currentDomain = null;
  }
}
```

**Files:** `services/config-service/src/server.ts`  
**Tests:** existing config unit tests cover this  
**Effort:** 5 min

---

### M1.6 — CA cert TODO comment in Dockerfiles (Finding #24)

**Problem:** All Node `Dockerfile`s run `npm config set strict-ssl false` to work around a corporate SSL proxy. TLS certificate verification is disabled for `npm install`, silently trusting any MITM cert. A proper fix requires installing the corporate CA cert, which is not currently available.

**Fix:** Add a one-line comment to each Node `Dockerfile` above the line:

```dockerfile
# TODO: replace with corporate CA cert installation when cert is available
#   (RUN apt-get install -y ca-certificates && COPY corp-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates)
#   Until then, strict-ssl false is a documented workaround for the corporate SSL proxy.
RUN npm config set strict-ssl false
```

**Files:** All Node `Dockerfile`s (auth-service, url-service, redirect-service, admin-service, admin-ui, config-service)  
**Effort:** 10 min

---

### M1.7 — admin-ui missing from test helper BASE map (§4.7)

**Problem:** `tests/integration/helpers.js` defines `BASE` with URLs for all services except admin-ui. The M6 admin-ui integration tests fall back to a hardcoded `http://localhost:3004`.

**Fix:**

```js
export const BASE = {
  config:    'http://localhost:3000',
  auth:      'http://localhost:3001',
  urls:      'http://localhost:3002',
  redirect:  'http://localhost:8080',
  admin:     'http://localhost:3003',
  adminUi:   'http://localhost:3004',  // ← add
  analytics: 'http://localhost:3005',
};
```

Update M6 admin-ui test files to use `BASE.adminUi` instead of the hardcoded string.

**Files:** `tests/integration/helpers.js`, `tests/integration/m6-admin-ui.test.js`  
**Effort:** 10 min

---

### M1.8 — HTTPS-only domain validation in config-service (§5.4)


**Problem:** The AJV schema for `PUT /config/domain` validates `uri` format but allows `http://`. Setting a plain-HTTP domain means all generated short URLs reference an insecure base. In non-development environments this should be rejected.

**Fix:** Add a `pattern` constraint to the AJV schema that enforces `https:` when `NODE_ENV !== 'development'`:

```ts
// config-service/src/server.ts — in the schema definition
const schema = {
  type: 'object',
  properties: {
    domain: {
      type: 'string',
      format: 'uri',
      ...(process.env.NODE_ENV !== 'development' && {
        pattern: '^https://'
      })
    }
  },
  required: ['domain']
};
```

**Files:** `services/config-service/src/server.ts`  
**Tests:** add one test case to config unit tests: `http://` domain rejected in non-dev  
**Effort:** 15 min

---

### M1.9 — Swagger API path fragility in config-service (§4.5)

**Problem:** `config-service/src/server.ts` computes the `swagger-jsdoc` `apis` path using `__dirname`, which differs between development (ts-node: `src/`) and production (tsc output: `dist/`). A glob like `*.js` finds `dist/server.js` in prod but misses it in dev, or vice versa. Any `tsc` output-directory change silently produces empty Swagger docs.

**Fix:** Provide both paths explicitly so swagger-jsdoc processes whichever exists at runtime:

```ts
// config-service/src/server.ts
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const swaggerSpec = swaggerJsdoc({
  definition: { /* unchanged */ },
  apis: [
    join(__dirname, 'server.ts'),   // ts-node (dev): __dirname = src/
    join(__dirname, 'server.js'),   // tsc (prod):    __dirname = dist/
  ],
});
```

swagger-jsdoc silently skips paths that do not exist, so the double-path list works without conditional logic.

**Files:** `services/config-service/src/server.ts`  
**Tests:** existing config unit tests cover Swagger spec generation; add an assertion that the spec is non-empty  
**Effort:** 15 min

---

## Milestone 2 — Security: URL and Redirect Layer

### M2.1 — URL scheme allowlist (Finding #1)

**Problem:** `url-service/src/index.js:192-196` uses `new URL(url)` which validates syntax only. `javascript:alert(1)`, `data:text/html,...`, and `file:///etc/passwd` pass the check, get stored in MySQL, and are served as 302 `Location` headers by redirect-service. Modern browsers block these schemes in `Location` headers; non-browser clients (curl, webhooks, mobile apps) receive the payload verbatim.

**Fix:** After the try/catch, check the parsed protocol:

```js
// url-service/src/index.js, after line 195
let parsed;
try {
  parsed = new URL(url);
} catch {
  return res.status(400).json({ error: 'Invalid URL format' });
}
if (!['http:', 'https:'].includes(parsed.protocol)) {
  return res.status(400).json({ error: 'Only http and https URLs are allowed' });
}
```

**Files:** `services/url-service/src/index.js:192-196`  
**Tests:**
- Unit test in `url-service/src/utils.test.js` (or equivalent) for `javascript:`, `data:`, `file:`, `ftp:` schemes → 400
- Integration test: `POST /urls` with `javascript:alert(1)` → 400

**Effort:** 20 min

---

### M2.2 — Reserved slug shadowing (Finding #2)

**Problem:** A user can create a short URL with slug `health`, `ready`, or `metrics`. Express registers `/health`, `/ready`, and `/metrics` before `/:slug` in redirect-service, so these routes take priority. The short URL is stored successfully but permanently unreachable via that slug.

**Fix:** Add a `RESERVED_SLUGS` set to `url-service/src/utils.js` and check it in the URL creation handler:

```js
// url-service/src/utils.js
export const RESERVED_SLUGS = new Set(['health', 'ready', 'metrics']);

export function isValidSlug(slug) {
  return (
    typeof slug === 'string' &&
    SLUG_PATTERN.test(slug) &&
    slug.length <= SLUG_MAX_LEN &&
    !RESERVED_SLUGS.has(slug)
  );
}
```

This catches reserved slugs at creation time with a 400 response. No changes needed to redirect-service routing order.

**Files:** `services/url-service/src/utils.js`  
**Tests:**
- Unit test: `isValidSlug('health')` → `false`, same for `ready`, `metrics`
- Integration test: `POST /urls { customSlug: 'health' }` → 400

**Effort:** 20 min

---

### M2.3 — XSS in redirect root page + CSP headers (Finding #6 + #19 partial)

**Problem:** `redirect-service/src/index.js:213` interpolates `config.domain` directly into an HTML template string without escaping. Although AJV validates the domain as a URI (which rejects `<script>` tags), some browsers tolerate angle brackets in URIs. Additionally, no Content-Security-Policy header is set on any HTML response in redirect-service or admin-ui.

**Fix (part 1 — HTML escape):** Add an escape function and use it:

```js
// redirect-service/src/index.js — add near top
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// line 213
<p>Domain: <code>${escapeHtml(config.domain)}</code></p>
```

**Fix (part 2 — CSP middleware):** Add a CSP header to all HTML responses in redirect-service. Inline styles are used in the HTML templates, so `style-src 'unsafe-inline'` is required until styles are extracted to an external file:

```js
// redirect-service/src/index.js — add to app middleware stack
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'"
  );
  next();
});
```

**Files:** `services/redirect-service/src/index.js`  
**Tests:**
- Unit test: `escapeHtml('<script>alert(1)</script>')` → escaped string
- Integration test: `GET /` response body does not contain unescaped `<`, `>`

**Effort:** 30 min

---

### M2.4 — Rate limiting on `GET /:slug` (§4.3)

**Problem:** The public redirect endpoint has no rate limiting. A bot can enumerate slugs at full speed.

**Fix:** Add a lightweight rate limiter to the `/:slug` route using the existing ioredis client and RedisStore. Use a generous limit (e.g., 300 req per minute per IP) to avoid false positives on legitimate browsers:

```js
// redirect-service/src/index.js — after existing imports
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

const redirectLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl-redirect:'
  }),
  message: { error: 'Too many requests' }
});

app.get('/:slug', redirectLimiter, async (req, res) => { ... });
```

Add `express-rate-limit` and `rate-limit-redis` to redirect-service `package.json` if not already present.

**Files:** `services/redirect-service/src/index.js`, `services/redirect-service/package.json`  
**Tests:** integration test: 301+ requests in 1 min from same IP → 429  
**Effort:** 30 min

---

## Milestone 3 — Security: auth-service

### M3.1 — First-user admin race condition (Finding #5)

**Problem:** `auth-service/src/db.js:18-27` runs `SELECT COUNT(*)` then `INSERT` as two separate statements. Two concurrent first-user registrations with different email addresses can both see `count = 0` and both receive `role = 'admin'`.

**Correction to the review's suggested fix:** The review recommends `INSERT…SELECT` with a CTE. A CTE at `READ COMMITTED` isolation (PostgreSQL default) is **not atomic** — both transactions can read the same row count before either inserts. The correct fix is a transaction with an explicit table lock to serialize the COUNT + INSERT pair.

**Fix:** Wrap `createUser` in a `sql.begin` transaction and lock the table during the check-and-insert:

```js
// auth-service/src/db.js
export async function createUser(email, passwordHash) {
  return sql.begin(async sql => {
    // SHARE ROW EXCLUSIVE prevents concurrent INSERT/UPDATE/DELETE
    // while not blocking reads, serialising the first-user detection.
    await sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
    const [{ count }] = await sql`SELECT COUNT(*) as count FROM users`;
    const role = parseInt(count) === 0 ? 'admin' : 'user';
    const [user] = await sql`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${passwordHash}, ${role})
      RETURNING id, email, role, created_at
    `;
    return user;
  });
}
```

The lock is released automatically when the transaction commits or rolls back. For all registrations after the first, `count > 0` so the lock contention is sub-millisecond.

**Files:** `services/auth-service/src/db.js:18-27`  
**Tests:** race condition is hard to reproduce in unit tests; add a comment explaining the invariant. Integration test: concurrent first-user registrations (two simultaneous `POST /auth/register`) → at most one admin.  
**Effort:** 30 min

---

### M3.2 — `isValidApiKeyFormat` dead code on hot path (Finding #13)

**Problem:** `auth-service/src/utils.js` exports `isValidApiKeyFormat` (checks `msh_` prefix, length 36), it is unit-tested, but `validateApiKey` in `db.js` never calls it. A key with the wrong format (missing prefix, wrong length) triggers a SHA-256 hash and a database lookup before returning a miss.

**Fix:** Call `isValidApiKeyFormat` at the top of `validateApiKey`, before hashing:

```js
// auth-service/src/db.js
import { hashKey, isValidApiKeyFormat } from './utils.js';

export async function validateApiKey(key) {
  if (!isValidApiKeyFormat(key)) return undefined;
  const keyHash = hashKey(key);
  // ... rest unchanged
}
```

**Files:** `services/auth-service/src/db.js:53`  
**Tests:** existing unit tests already cover `isValidApiKeyFormat`; add a test that `validateApiKey` returns `undefined` without hitting the DB for a malformed key (mock the `sql` tag).  
**Effort:** 15 min

---

### M3.3 — `getAllUsers` no LIMIT + cursor pagination (Finding #14)

**Problem:** `auth-service/src/db.js:104-116` runs `SELECT * FROM users ORDER BY created_at DESC` with no `LIMIT`. At scale this is a full-table scan delivered as a single response.

**Fix:** Add cursor-based pagination to `getAllUsers` and expose it via the `/admin/users` route. Use `id` as the cursor (monotonically increasing, available without extra index):

```js
// auth-service/src/db.js
export async function getAllUsers({ cursor, limit = 50 } = {}) {
  const users = cursor
    ? await sql`
        SELECT id, email, role, created_at FROM users
        WHERE id < ${cursor}
        ORDER BY id DESC LIMIT ${limit + 1}`
    : await sql`
        SELECT id, email, role, created_at FROM users
        ORDER BY id DESC LIMIT ${limit + 1}`;

  const hasMore = users.length > limit;
  const page = hasMore ? users.slice(0, limit) : users;
  return {
    users: page.map(u => ({ id: u.id, email: u.email, role: u.role, createdAt: u.created_at })),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
}
```

Update `GET /admin/users` to accept `?cursor=<id>&limit=<n>` and pass through to `getAllUsers`.

**Files:** `services/auth-service/src/db.js:104-116`, `services/auth-service/src/index.js`  
**Tests:** unit test: `getAllUsers` with cursor returns correct page and `nextCursor`  
**Effort:** 45 min

---

## Milestone 4 — Inline Auth Refactor + Internal Admin Endpoints

These items are grouped because they share files and M4.3–M4.5 depend on the middleware from M4.1–M4.2. M12 (per-service tokens) depends on M4.3–M4.5.

### M4.1 — Extract `requireAdmin` middleware in auth-service (Finding #10)

**Problem:** `auth-service/src/index.js:200-211` and `:222-233` both replicate:
```js
const apiKey = req.headers['x-api-key'];
if (!apiKey) return res.status(401).json(...);
const keyData = await validateApiKey(apiKey);
if (!keyData || keyData.role !== 'admin') return res.status(403).json(...);
```

**Fix:** Extract to a reusable async middleware and apply it to both routes:

```js
// auth-service/src/index.js — add after the verifyToken middleware
async function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const keyData = await validateApiKey(apiKey);
  if (!keyData || keyData.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.admin = keyData;
  next();
}

// Replace both inline auth blocks:
app.get('/admin/users', requireAdmin, async (req, res) => { ... });
app.get('/admin/stats', requireAdmin, async (req, res) => { ... });
```

**Files:** `services/auth-service/src/index.js:200-240`  
**Tests:** unit test for `requireAdmin` (mock `validateApiKey`)  
**Effort:** 20 min

---

### M4.2 — Extract `requireAdminApiKey` middleware in url-service (Finding #10)

**Problem:** `url-service/src/index.js:300-325` and `:349-374` both inline a `fetch` to `POST /auth/validate`. This is a different pattern than auth-service (which calls `validateApiKey` directly) and must be extracted separately.

**Fix:** Extract to a middleware:

```js
// url-service/src/index.js
async function requireAdminApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': req.id },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return res.status(401).json({ error: 'Invalid API key' });
    const data = await response.json();
    if (!data.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    req.admin = { id: data.userId, role: data.role };
    next();
  } catch (err) {
    req.log.error({ err }, 'Admin auth validation error');
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
}

app.get('/admin/urls',  requireAdminApiKey, async (req, res) => { ... });
app.get('/admin/stats', requireAdminApiKey, async (req, res) => { ... });
```

**Files:** `services/url-service/src/index.js:300-382`  
**Effort:** 20 min

---

### M4.3 — Add `/internal/admin/stats` to auth-service (Finding #9)

**Problem:** `GET /admin/dashboard` on admin-service validates the user's API key once via `validateAdminKey` middleware, then forwards the raw `X-API-Key` header to `auth-service /admin/stats` and `url-service /admin/stats`, each of which validates again — **3 auth-service roundtrips per dashboard request**.

**Fix (part 1):** Add an internal endpoint to auth-service protected by `X-Service-Token` (the `SERVICE_TOKEN` env var — to be replaced by a per-service token in M12). This endpoint returns the same payload as `/admin/stats` but bypasses API-key validation:

```js
// auth-service/src/index.js
function requireServiceToken(req, res, next) {
  const token = req.headers['x-service-token'];
  if (!token || token !== env.SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/internal/admin/stats', requireServiceToken, async (req, res) => {
  try {
    const stats = await getAuthStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Internal admin stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Files:** `services/auth-service/src/index.js`, `services/auth-service/src/env.js` (ensure `SERVICE_TOKEN` is validated)  
**Effort:** 20 min

---

### M4.4 — Add `/internal/admin/stats` to url-service (Finding #9)

Same pattern as M4.3 for url-service. Returns the same payload as `GET /admin/stats` but accepts `X-Service-Token` instead of `X-API-Key`.

```js
// url-service/src/index.js
function requireServiceToken(req, res, next) {
  const token = req.headers['x-service-token'];
  if (!token || token !== env.SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/internal/admin/stats', requireServiceToken, async (req, res) => {
  try {
    const stats = await getUrlStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, 'Internal admin stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Files:** `services/url-service/src/index.js`  
**Effort:** 20 min

---

### M4.5 — Update admin-service to use internal endpoints (Finding #9)

**Problem (continued from M4.3):** `admin-service/src/index.js:148-165` forwards `X-API-Key` to `auth-service /admin/stats` and `url-service /admin/stats`, triggering redundant validation in each.

**Fix:** Replace the two calls in `GET /admin/dashboard` with calls to the new `/internal/admin/stats` endpoints, using `X-Service-Token` instead of forwarding the user's API key:

```js
// admin-service/src/index.js:148-165
const [authData, urlData, overviewData, topData] = await Promise.all([
  fetchUpstream(`${AUTH_SERVICE_URL}/internal/admin/stats`, {
    headers: { 'X-Service-Token': SERVICE_TOKEN, ...sharedHeaders },
    signal: AbortSignal.timeout(2000)
  }, req.log),
  fetchUpstream(`${URL_SERVICE_URL}/internal/admin/stats`, {
    headers: { 'X-Service-Token': SERVICE_TOKEN, ...sharedHeaders },
    signal: AbortSignal.timeout(2000)
  }, req.log),
  // analytics calls stay unchanged
  ...
]);
```

**Files:** `services/admin-service/src/index.js:148-165`  
**Effort:** 20 min

---

## Milestone 5 — Performance and Scale

### M5.1 — `syncClickCounts` unbounded query string (Finding #7)

**Problem:** `url-service/src/index.js:394` joins all slug strings into a query parameter: `?slugs=abc,def,...`. With 100,000 URLs at 6–8 chars each, this exceeds 700 KB — past Nginx's default 8 KB header limit, causing the request to fail silently.

**Fix (two-part):**

**Part A — Add `POST /stats/counts` to analytics-service:**

```java
// StatsController.java
@PostMapping("/counts")
public ResponseEntity<Map<String, Long>> countsByPost(@RequestBody List<String> slugs) {
    if (slugs == null || slugs.isEmpty()) return ResponseEntity.ok(Map.of());
    if (slugs.size() > 2000) return ResponseEntity.status(413).build();
    return ResponseEntity.ok(repository.getCounts(slugs));
}
```

Keep the existing `GET /counts` for backwards compatibility.

**Part B — Update `syncClickCounts` in url-service to use POST with batching:**

```js
// url-service/src/index.js
const BATCH_SIZE = 500;
async function syncClickCounts() {
  const [rows] = await pool.execute('SELECT slug FROM urls');
  if (rows.length === 0) return;
  
  const slugs = rows.map(r => r.slug);
  const counts = {};
  
  // Process in batches of 500
  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${ANALYTICS_SERVICE_URL}/stats/counts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': SERVICE_TOKEN,
        'x-request-id': jobId
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) { /* log and continue */ continue; }
    Object.assign(counts, await res.json());
  }
  // update click counts...
}
```

**Files:**
- `services/analytics-service/src/main/java/.../controller/StatsController.java`
- `services/url-service/src/index.js:384-418`

**Tests:**
- Java unit test for new `POST /counts` endpoint
- Integration test: large slug set sync doesn't fail

**Effort:** 45 min

---

### M5.2 — `getAllUrls` cursor pagination (Finding #15)

**Problem:** `url-service/src/db.js:79-85` uses `LIMIT 1000` with no pagination cursor. Admin URL list silently truncates beyond 1000 URLs and provides no way to page.

**Fix:** Add cursor-based pagination using `id` (same approach as M3.3):

```js
// url-service/src/db.js
export async function getAllUrls({ cursor, limit = 50 } = {}) {
  const [rows] = cursor
    ? await pool.execute(
        'SELECT * FROM urls WHERE id < ? ORDER BY id DESC LIMIT ?',
        [cursor, limit + 1]
      )
    : await pool.execute(
        'SELECT * FROM urls ORDER BY id DESC LIMIT ?',
        [limit + 1]
      );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    urls: page,
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
}
```

Update `GET /admin/urls` to accept and forward `?cursor=<id>&limit=<n>`. Include `nextCursor` in the JSON response so admin-service and admin-ui can page through results.

**Files:** `services/url-service/src/db.js:79-94`, `services/url-service/src/index.js`  
**Effort:** 45 min

---

### M5.3 — `searchUrls` full-table scan (Finding #16)

**Problem:** `url-service/src/db.js:87-94` uses `slug LIKE '%q%' OR long_url LIKE '%q%'`. Leading wildcards disable B-tree index use — full-table scan at O(n).

**Fix:** Use MySQL FULLTEXT indexes for `long_url` search; for `slug`, use prefix matching (which can use the existing UNIQUE index):

```sql
-- Add to services/url-service/init/schema.sql (or a migration)
ALTER TABLE urls ADD FULLTEXT INDEX ft_long_url (long_url);
```

```js
// url-service/src/db.js
export async function searchUrls(q) {
  // slug: prefix match uses the UNIQUE B-tree index
  // long_url: FULLTEXT MATCH replaces the leading-wildcard LIKE (which forces a full scan)
  const prefix = `${q}%`;
  const [rows] = await pool.execute(
    `SELECT * FROM urls
     WHERE slug LIKE ?
        OR MATCH(long_url) AGAINST(? IN BOOLEAN MODE)
     ORDER BY created_at DESC LIMIT 100`,
    [prefix, q]
  );
  return rows;
}
```

> Note: FULLTEXT minimum token length in MySQL InnoDB defaults to 3 chars. The `ft_min_token_size` variable may need to be set in `my.cnf` for very short queries. For a teaching project the defaults are fine. Document this in the schema migration comment.

**Files:** `services/url-service/src/db.js:87-94`, `services/url-service/init/schema.sql`  
**Effort:** 30 min

---

### M5.4 — Handle `ER_DUP_ENTRY` in createUrl (§4.2 TOCTOU)

**Problem:** `url-service/src/index.js:210-216`: a slug uniqueness check (`getUrlBySlug`) followed by an `INSERT` creates a TOCTOU window. Two concurrent requests with the same custom slug can both pass the check, and one then hits the MySQL `UNIQUE` constraint — currently propagated as an unhandled error → 500.

**Fix:** Catch the MySQL error code `1062` (`ER_DUP_ENTRY`) in the route handler and return a 409:

```js
// url-service/src/index.js, in the POST /urls handler
try {
  const urlRecord = await createUrl(req.user.id, url, slug);
  // ...
} catch (err) {
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Slug already in use' });
  }
  req.log.error({ err }, 'Create URL error');
  res.status(500).json({ error: 'Internal server error' });
}
```

**Files:** `services/url-service/src/index.js` (createUrl call site)  
**Tests:** unit/integration test: concurrent same-slug requests → one 201, one 409 (never 500)  
**Effort:** 15 min

---

### M5.5 — analytics-service batch size limit (Finding #11)

**Problem:** `EventController.java` `POST /events:batch` has no upper bound on batch size. A 100,000-event batch can spike JVM heap.

**Fix:** Add an explicit size check:

```java
@PostMapping("/events:batch")
public ResponseEntity<Void> ingestBatch(@RequestBody List<ClickEvent> events) {
    if (events == null || events.isEmpty()) return ResponseEntity.badRequest().build();
    if (events.size() > 1000) return ResponseEntity.status(413).build();
    repository.insertBatch(events);
    return ResponseEntity.accepted().build();
}
```

Update redirect-service `flushEvents()` to never send more than 1000 events per call (it already batches by `ANALYTICS_FLUSH_MS`, so this is an additional cap).

**Files:** `services/analytics-service/src/main/java/.../controller/EventController.java`  
**Tests:** unit test: `POST /events:batch` with 1001 events → 413  
**Effort:** 15 min

---

## Milestone 6 — Rate Limiter Observability

### M6.1 — Log/metric rate limiter bypass when Redis is unavailable (Finding #3)

**Problem:** `auth-service/src/index.js:91` and `url-service/src/index.js:95` set `passOnStoreError: true`. When Redis is unreachable, brute-force protection on `/auth/login` and `/auth/register` and creation-rate protection on `POST /urls` silently disappear. There is no metric or log to indicate this bypass is happening.

**Important:** `express-rate-limit` v8 has no built-in callback for the store-error bypass path. The correct approach is to increment a Prometheus counter and log at `warn` level **from the existing ioredis error event handler** — which already fires on Redis disconnects and fires before any rate-limit store call fails.

**Fix:**

```js
// auth-service/src/index.js (and identically in url-service)
// Add a Prometheus counter
const rateLimitBypass = new promClient.Counter({
  name: 'microshort_auth_rate_limit_bypass_total',
  help: 'Times rate limiting was bypassed due to Redis store unavailability'
});

// Update existing redis error handler:
redis.on('error', err => {
  logger.warn({ err }, 'Redis store unavailable — rate limiting bypassed (passOnStoreError=true)');
  rateLimitBypass.inc();
});
```

For url-service, use metric name `microshort_url_rate_limit_bypass_total`.

**Files:** `services/auth-service/src/index.js`, `services/url-service/src/index.js`  
**Tests:** note in tests that direct testing requires a simulated Redis failure  
**Effort:** 20 min

---

### M6.2 — Rate limit `POST /auth/validate` (Finding #3.8)

**Problem:** `auth-service/src/index.js:260-286` — `POST /auth/validate` has no rate limiting. Port 3001 is internal-only in compose, but if ever port-forwarded or deployed with a public port, this becomes a free API-key oracle.

**Fix:** Apply a dedicated, more permissive rate limiter to this endpoint (higher limit than auth routes — it's called by other services):

```js
const validateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 500,
  standardHeaders: 'draft-6',
  legacyHeaders: false,
  passOnStoreError: true,
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl-validate:' }),
  message: { error: 'Too many validation requests' }
});

app.post('/auth/validate', validateLimiter, async (req, res) => { ... });
```

**Files:** `services/auth-service/src/index.js`  
**Effort:** 20 min

---

## Milestone 7 — Constant-Time Token Comparison

### M7.1 — config-service `timingSafeEqual` fix (Finding #12)

**Problem:** `config-service/src/server.ts:134` uses `!==` to compare the expected `CONFIG_WRITE_TOKEN` against the request header. `!==` is not constant-time.

**Correction to the review's code snippet:** `crypto.timingSafeEqual(a, b)` throws `RangeError` if `a.length !== b.length`. Since `token` is attacker-controlled, a wrong-length token → exception → 500, leaking length information. The safe pattern is to hash both values to a fixed-length SHA-256 digest first:

```ts
// config-service/src/server.ts
import { timingSafeEqual, createHash } from 'crypto';

function safeTokenEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// in PUT /config/domain handler:
const expected = env.CONFIG_WRITE_TOKEN;
const token = req.headers['x-service-token'] as string ?? '';
if (!expected || !safeTokenEqual(expected, token)) {
  res.status(401).json({ error: 'Unauthorized' });
  return;
}
```

**Files:** `services/config-service/src/server.ts:132-137`  
**Tests:** add unit test: wrong token returns 401, correct token returns 200  
**Effort:** 20 min

---

### M7.2 — analytics-service `ServiceTokenFilter` constant-time comparison (Finding #12)

**Problem:** `ServiceTokenFilter.java:22` uses `String.equals()` which is not constant-time for token comparison.

**Correction:** `MessageDigest.isEqual` IS constant-time (per Java docs). The fix is to hash both strings to SHA-256 first (fixed 32 bytes), then use `MessageDigest.isEqual`:

```java
// ServiceTokenFilter.java
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;

private boolean safeTokenEqual(String a, String b) {
    try {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] aBytes = md.digest(a.getBytes(StandardCharsets.UTF_8));
        md.reset();
        byte[] bBytes = md.digest(b.getBytes(StandardCharsets.UTF_8));
        return MessageDigest.isEqual(aBytes, bBytes);
    } catch (Exception e) {
        return false;
    }
}

// In doFilterInternal:
String token = req.getHeader("X-Service-Token");
if (serviceToken == null || token == null || !safeTokenEqual(serviceToken, token)) {
    // ... return 401
}
```

**Files:** `services/analytics-service/src/main/java/.../config/ServiceTokenFilter.java`  
**Tests:** add unit test to `AnalyticsApplicationTests` or a dedicated filter test  
**Effort:** 20 min

---

## Milestone 8 — CORS Configuration

### M8.1 — `ALLOWED_ORIGINS` env var (Finding #23)

**Problem:** `auth-service/src/index.js:70`, `url-service/src/index.js:74`, and `admin-service/src/index.js:51` all call `cors()` with no options, returning `Access-Control-Allow-Origin: *`. While CSRF is not a concern (no cookies), wildcard CORS allows any website to make authenticated API calls on behalf of users with API keys in browser contexts.

**Fix:** Add `ALLOWED_ORIGINS` to each service's env validation, defaulting to `*` so local dev requires no config change:

```js
// env.js (per service)
ALLOWED_ORIGINS: str({ default: '*' }),
```

```js
// index.js
import cors from 'cors';
const allowedOrigins = env.ALLOWED_ORIGINS === '*'
  ? '*'
  : env.ALLOWED_ORIGINS.split(',').map(o => o.trim());

app.use(cors({ origin: allowedOrigins }));
```

Add to `.env.example`:
```
# Comma-separated list of allowed CORS origins (default: * — restrict for production)
# ALLOWED_ORIGINS=http://localhost:3004
```

**Files:** `services/auth-service/src/env.js`, `services/url-service/src/env.js`, `services/admin-service/src/env.js`, all three `src/index.js`, `.env.example`  
**Tests:** unit test: `ALLOWED_ORIGINS=http://localhost:3004` → `cors` called with that origin  
**Effort:** 30 min

---

## Milestone 9 — admin-ui Observability and Security

### M9.1 — Restrict `express.static` to public directory (Finding #18)

**Problem:** `admin-ui/server.js:12` uses `express.static(__dirname)`, serving every file in the working directory including `server.js` itself. Any user can `GET /server.js` and read the server source.

**Fix:** Create a `public/` subdirectory, move all static assets into it, and serve only that directory:

```
services/admin-ui/
  public/
    index.html
    app.js
    vendor/
      van.min.js
      htm.module.js
  server.js       ← server source, NOT served
```

```js
// server.js
app.use(express.static(path.join(__dirname, 'public')));
```

The `/config.js` dynamic endpoint stays on the server directly (it is not a static file).

Update the `Dockerfile` to `COPY public ./public` instead of `COPY . .` (or explicitly exclude `server.js` from the static root).

**Files:** `services/admin-ui/server.js:12`, move all static files into `services/admin-ui/public/`  
**Effort:** 30 min

---

### M9.2 — Content Security Policy header on admin-ui (Finding #19)

**Problem:** No CSP header is set on admin-ui responses. Without it, any XSS can steal the API key from `localStorage`.

**Fix:** Add a CSP middleware to `server.js`. The CSP must allow `connect-src` to `ADMIN_API_URL` (runtime-configurable). Inline scripts are not used; all scripts are served from the same origin:

```js
// admin-ui/server.js
app.use((req, res, next) => {
  const apiBase = process.env.ADMIN_API_URL || 'http://localhost:3003';
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; connect-src 'self' ${apiBase}; style-src 'self' 'unsafe-inline'; script-src 'self'`
  );
  next();
});
```

**Files:** `services/admin-ui/server.js`  
**Effort:** 20 min

---

### M9.3 — Add pino structured logging to admin-ui (Finding #17)

**Problem:** `admin-ui/server.js` uses `console.log`/`console.error` throughout. It is invisible to JSON log aggregators that expect pino-format output.

**Fix:** Add `pino-http` dependency and replace all `console.log`/`console.error` calls:

```js
// admin-ui/server.js
import pino from 'pino';
import pinoHttp from 'pino-http';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(pinoHttp({ logger }));

// Replace console.log in startup/shutdown:
logger.info({ port: PORT }, 'Admin UI started');
```

Add `pino` and `pino-http` to `services/admin-ui/package.json`.

**Files:** `services/admin-ui/server.js`, `services/admin-ui/package.json`  
**Effort:** 20 min

---

### M9.4 — Add Prometheus metrics to admin-ui (Finding #17)

**Problem:** admin-ui is the only service without a `GET /metrics` endpoint, breaking the observability contract from `ARCHITECTURE.md`.

**Fix:** Add `prom-client` and expose default metrics + an HTTP request counter:

```js
// admin-ui/server.js
import promClient from 'prom-client';

promClient.collectDefaultMetrics({ prefix: 'microshort_admin_ui_' });
const httpRequests = new promClient.Counter({
  name: 'microshort_admin_ui_http_requests_total',
  labelNames: ['method', 'status']
});

app.use((req, res, next) => {
  res.on('finish', () => httpRequests.inc({ method: req.method, status: String(res.statusCode) }));
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});
```

Add `prom-client` to `services/admin-ui/package.json`.

**Files:** `services/admin-ui/server.js`, `services/admin-ui/package.json`  
**Effort:** 20 min

---

## Milestone 10 — JWT Refresh Tokens (Finding #22)

**Problem:** JWTs are valid for 7 days. If an admin's role is revoked, their token remains valid for up to 7 days. There is no revocation mechanism.

**Chosen approach:** Shorten JWT TTL to 1 hour (access token) and add a 7-day refresh token flow. No revocation table is added (that would require a DB lookup on every JWT-authenticated request).

### M10.1 — Shorten JWT access token TTL

Change `JWT_EXPIRES_IN` default from `7d` to `1h`. Add `REFRESH_TOKEN_EXPIRES_IN` defaulting to `7d`.

```js
// auth-service/src/env.js
JWT_EXPIRES_IN:          str({ default: '1h' }),
REFRESH_TOKEN_EXPIRES_IN: str({ default: '7d' }),
```

### M10.2 — Add refresh token to login/register responses

```js
// auth-service/src/index.js — in login + register handlers
const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
const refreshToken = jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: env.REFRESH_TOKEN_EXPIRES_IN });

res.json({ token, refreshToken, ... });
```

### M10.3 — Add `POST /auth/refresh` endpoint

```js
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(400).json({ error: 'Invalid token type' });
    const user = await getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
    res.json({ token });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});
```

Add `getUserById` to `auth-service/src/db.js`.

### M10.4 — Update admin-ui to handle token refresh

When a JWT-protected API call returns 401, admin-ui should call `POST /auth/refresh` and retry. Update `admin-ui/app.js` to:
1. Store both `token` and `refreshToken` in `localStorage`
2. Wrap authenticated fetch calls with a refresh-and-retry handler

**Files:** `services/auth-service/src/env.js`, `services/auth-service/src/index.js`, `services/auth-service/src/db.js`, `services/admin-ui/app.js`  
**Tests:**
- Unit test: login response includes `refreshToken`
- Unit test: `POST /auth/refresh` with valid refresh token → new access token
- Unit test: `POST /auth/refresh` with expired/invalid token → 401
- Integration test: verify 1h expiry enforced

**Effort:** 2 hours

---

## Milestone 11 — URL Update Endpoint (§4.2 / §5.5)

**Problem:** There is no `PUT /urls/:slug` endpoint. To change a long URL, users must delete and recreate, losing the slug (if not custom) and all click history.

### M11.1 — Add `PUT /urls/:slug` to url-service

```js
// url-service/src/index.js
app.put('/urls/:slug', requireApiKey, async (req, res) => {
  try {
    const { slug } = req.params;
    const { url: newUrl } = req.body;
    if (!newUrl) return res.status(400).json({ error: 'URL required' });

    let parsed;
    try { parsed = new URL(newUrl); } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http and https URLs are allowed' });
    }

    const urlRecord = await getUrlBySlug(slug);
    if (!urlRecord) return res.status(404).json({ error: 'URL not found' });
    if (urlRecord.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const updated = await updateUrl(urlRecord.id, newUrl);
    const domain = await getDomain(req.id);
    res.json({ shortUrl: `${domain}/${slug}`, longUrl: updated.long_url, slug });
  } catch (err) {
    req.log.error({ err }, 'Update URL error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

Add `updateUrl(id, newLongUrl)` to `url-service/src/db.js`.

### M11.2 — Expose URL editing in admin-ui

Add an edit button/form to the URL list in `admin-ui/app.js` that calls `PUT /urls/:slug` via admin-service (or directly to url-service via the user's API key).

### M11.3 — Integration test

`PUT /urls/:slug` with valid API key → 200 with updated longUrl; subsequent redirect follows new URL.

**Files:** `services/url-service/src/index.js`, `services/url-service/src/db.js`, `services/admin-ui/app.js`  
**Effort:** 1.5 hours

---

## Milestone 12 — Per-Service Tokens (§5.4)

**Prerequisite:** M4 must be complete (internal admin endpoints exist with their own auth).

**Problem:** All service-to-service calls share a single `SERVICE_TOKEN`. Compromise of this one token allows impersonation of any internal service.

**Design:** Each calling service has its own outbound token. Each receiving service validates against only the token(s) it expects from its callers.

### Token inventory

| Env var | Injected into | Purpose |
|---|---|---|
| `REDIRECT_SERVICE_TOKEN` | redirect-service (out), analytics-service (in) | redirect → analytics |
| `URL_SERVICE_TOKEN` | url-service (out), analytics-service (in) | url → analytics |
| `ADMIN_SERVICE_TOKEN` | admin-service (out), analytics/auth/url (in) | admin → analytics, auth, url internal |
| `CONFIG_WRITE_TOKEN` | admin-service (out), config-service (in) | unchanged |

### M12.1 — Update analytics-service to accept a set of tokens

Replace the single `service.token` Spring property with `service.allowed-tokens` (comma-separated):

```java
// ServiceTokenFilter.java
@Value("${service.allowed-tokens}")
private String allowedTokensRaw;

private Set<String> allowedTokens;

@PostConstruct
public void init() {
    allowedTokens = Arrays.stream(allowedTokensRaw.split(","))
        .map(String::trim)
        .filter(s -> !s.isBlank())
        .collect(Collectors.toSet());
}

// In doFilterInternal:
String token = req.getHeader("X-Service-Token");
boolean authorized = token != null && allowedTokens.stream()
    .anyMatch(expected -> safeTokenEqual(expected, token));
if (!authorized) { /* 401 */ }
```

```yaml
# application.properties
service.allowed-tokens=${REDIRECT_SERVICE_TOKEN},${URL_SERVICE_TOKEN},${ADMIN_SERVICE_TOKEN}
```

### M12.2 — Update auth-service and url-service internal endpoints

Replace `SERVICE_TOKEN` validation in `requireServiceToken` (M4.3, M4.4) with `ADMIN_SERVICE_TOKEN`:

```js
function requireServiceToken(req, res, next) {
  const token = req.headers['x-service-token'];
  if (!token || !safeTokenEqual(env.ADMIN_SERVICE_TOKEN, token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

Add `ADMIN_SERVICE_TOKEN` to each service's `env.js`.

### M12.3 — Update each calling service

- redirect-service: use `REDIRECT_SERVICE_TOKEN` in `X-Service-Token` header when calling analytics
- url-service: use `URL_SERVICE_TOKEN` when calling analytics; use `ADMIN_SERVICE_TOKEN` when calling auth/url internal endpoints via admin-service (N/A — url-service doesn't call internal endpoints)
- admin-service: use `ADMIN_SERVICE_TOKEN` for all internal service calls

### M12.4 — Update compose.yml and `.env.example`

Add the three new tokens to `.env.example`:
```
REDIRECT_SERVICE_TOKEN=redirect-token-change-in-production
URL_SERVICE_TOKEN=url-token-change-in-production
ADMIN_SERVICE_TOKEN=admin-token-change-in-production
```

Update compose.yml to inject the correct token into each service.

Deprecate the old `SERVICE_TOKEN` — keep it in compose.yml with a comment for one release, then remove.

**Files:** All service `env.js` files, `ServiceTokenFilter.java`, `application.properties`, `compose.yml`, `.env.example`  
**Tests:** integration test: each service correctly rejected with wrong token; accepted with correct token  
**Effort:** 2 hours

---

## Milestone 13 — CI/CD

### M13.1 — Rate-limit integration test workflow (Finding #21)

**Problem:** `npm run test:e2e:rate` exercises rate-limiting with a fresh stack but no CI workflow runs it. Rate-limiting regressions are invisible in CI.

**Fix:** Add a new GitHub Actions workflow `.github/workflows/integration-rate-limit.yml`:

```yaml
name: Rate-limit integration tests
on:
  push:
    branches: [main]
  pull_request:
    paths:
      - 'services/auth-service/**'
      - 'services/url-service/**'
      - 'services/redirect-service/**'
      - 'tests/integration/rate-limit/**'
      - 'compose.yml'
      - '.env.example'

jobs:
  rate-limit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cp .env.example .env
      - run: npm install
      - run: npm run test:e2e:rate
      - if: failure()
        run: docker compose logs
```

**Files:** `.github/workflows/integration-rate-limit.yml` (new)  
**Effort:** 30 min

---

### M13.2 — Docker push for all service workflows (§5.2)

**Problem:** Only `config-service.yml` pushes to GHCR. All other service images must be rebuilt from source on every deployment; no artifact trail exists.

**Fix:** Add `docker/login-action` + `docker/build-push-action` to each service's CI workflow. Mirror the pattern already in `config-service.yml`:

```yaml
# Add to each service workflow (after unit tests + build smoke test)
- name: Log in to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Build and push image
  uses: docker/build-push-action@v5
  with:
    context: services/<service-name>
    push: ${{ github.ref == 'refs/heads/main' }}
    tags: ghcr.io/pxl-digital-application-samples/microshort-<service-name>:latest
```

Images are pushed only on `main` branch merges (not on PRs), controlled by the `push:` condition.

**Affected workflows:** `services.yml` (Node matrix — check if this can be parameterised), or individual per-service workflow files.

**Files:** `.github/workflows/services.yml`, `.github/workflows/analytics-service.yml` (add push step)  
**Effort:** 45 min

---

## Milestone 14 — Test Coverage

### M14.1 — analytics-service unit tests (§5.1 + §4.6)

**Problem:** `AnalyticsApplicationTests.java` contains only a `contextLoads` test (Spring context startup). No controller behavior, no repository queries, no filter chain logic is covered.

**Fix:** Add tests using `@WebMvcTest` (controller layer) and `@MockBean` (repository):

- `EventControllerTest`: 
  - Single event ingest → 202
  - Batch ingest (valid) → 202
  - Batch ingest (empty list) → 400
  - Batch ingest (> 1000 events) → 413
- `StatsControllerTest`:
  - `GET /stats/counts` with slugs query param → mocked counts returned
  - `POST /stats/counts` with JSON body → mocked counts returned
- `ServiceTokenFilterTest`:
  - Request with valid token → passes through
  - Request with invalid token → 401
  - Request with wrong-length token → 401 (not 500)
  - Request to `/actuator/*` without token → passes through

**Files:** `services/analytics-service/src/test/java/.../` (new test classes)  
**Effort:** 2 hours

---

### M14.2 — admin-service unit tests (§4.4)

**Problem:** admin-service has no `vitest.config.js`, no `test` script in `package.json`, and no test files. The aggregation logic, degraded-mode behavior, dashboard caching, and `validateAdminKey` middleware are entirely untested.

**Fix:** Add vitest and write unit tests:

```js
// services/admin-service/src/index.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test validateAdminKey middleware
// Test dashboard degraded array when an upstream fails
// Test dashboard cache serves stale response within TTL
// Test fetchUpstream returns null on network error (no throw)
```

Add `vitest` to `devDependencies` and a `test` script to `package.json`. Add `admin-service` to the CI matrix `has_tests: true`.

**Files:** `services/admin-service/package.json`, `services/admin-service/src/index.test.js` (new), `.github/workflows/services.yml`  
**Effort:** 2 hours

---

## Out of Scope

| Item | Reason |
|---|---|
| Grafana dashboards + Alertmanager rules (§5.3) | Excluded by discussion — significant new infra work |
| Corporate CA cert in Dockerfiles (Finding #24) | Cert not currently available; TODO comment added (M1.6) |
| JWT revocation table | Shortening TTL to 1h chosen instead (M10) |
| `PUT /config/domain` persistence (§6 tradeoff) | Documented intentional design — ephemeral by design |
| Redis FLUSHALL isolation between rate-limit and slug cache (§6) | Documented tradeoff |
| SHA-256 IP hashing vs bcrypt (§6) | Documented privacy decision |
| `syncClickCounts` 60s eventual consistency (§6) | Documented CQRS tradeoff |
| `/metrics` endpoints unauthenticated on all services (§5.3) | Medium effort (basic auth or separate port); defer to a security hardening milestone |
| Separate SERVICE_TOKEN per service-pair for config-service write token | Already handled separately via `CONFIG_WRITE_TOKEN` |
| Dashboard endpoint stale-data / no cache-control (§4.4) | Reviewer hedges ("this is fine, but…"); admin-service caches with a short TTL; adding ETags is cosmetic at this traffic scale — deferred |
| Event buffer resets independently per replica (§4.3) | Documented at-most-once tradeoff in ARCHITECTURE.md; multi-replica deployment is out of scope for this compose stack |
| analytics-service readiness doesn't verify materialized-view health (§5.3) | ClickHouse view is created at startup; adding an MV-health probe is analytics-service infra work — deferred alongside Grafana |
| Rate-limit compose override file divergence (§5.1) | M13.1 CI workflow runs the rate-limit suite; the two-file maintainability concern is acknowledged but the files are small enough to keep in sync manually for now |

---

## Summary table

| # | Finding | Milestone | Effort |
|---|---|---|---|
| #1 | URL scheme allowlist | M2.1 | 20 min |
| #2 | Reserved slug shadowing | M2.2 | 20 min |
| #3 | Rate limiter fail-open bypass metric | M6.1 | 20 min |
| #4 | analytics-service `.gitignore` | M1.1 | 5 min |
| #5 | First-user admin race | M3.1 | 30 min |
| #6 | XSS + CSP on redirect root | M2.3 | 30 min |
| #7 | syncClickCounts unbounded query | M5.1 | 45 min |
| #8 | Hardcoded DB password in test helper | M1.2 | 5 min |
| #9 | Triple API-key validation | M4.3–M4.5 | 1h |
| #10 | Duplicate inline admin auth | M4.1–M4.2 | 40 min |
| #11 | analytics batch size unlimited | M5.5 | 15 min |
| #12 | Non-constant-time token compare | M7.1–M7.2 | 40 min |
| #13 | `isValidApiKeyFormat` dead on hot path | M3.2 | 15 min |
| #14 | `getAllUsers` no LIMIT | M3.3 | 45 min |
| #15 | `getAllUrls` no pagination cursor | M5.2 | 45 min |
| #16 | `searchUrls` full-table scan | M5.3 | 30 min |
| #17 | admin-ui no logging/metrics | M9.3–M9.4 | 40 min |
| #18 | `express.static(__dirname)` exposes server.js | M9.1 | 30 min |
| #19 | API key in localStorage without CSP | M9.2 | 20 min |
| #20 | `last_used_at` uses `console.error` | M1.3 | 10 min |
| #21 | Rate-limit tests not in CI | M13.1 | 30 min |
| #22 | JWT mutable role 7d window | M10 | 2h |
| #23 | Wildcard CORS | M8.1 | 30 min |
| #24 | `strict-ssl false` in Dockerfiles | M1.6 | 10 min |
| §4.2 | ER_DUP_ENTRY → 500 on concurrent slug | M5.4 | 15 min |
| §4.4 | admin-service no tests | M14.2 | 2h |
| §4.5 | `__resetConfigCache` leaks to production | M1.5 | 5 min |
| §4.5 | Swagger path fragile between dev and prod | M1.9 | 15 min |
| §4.6 | analytics unit tests cover context only | M14.1 | 2h |
| §4.7 | admin-ui missing from test BASE map | M1.7 | 10 min |
| §5.2 | Docker push for all service workflows | M13.2 | 45 min |
| §5.4 | One shared SERVICE_TOKEN | M12 | 2h |
| §5.4 | HTTPS-only domain in non-dev | M1.8 | 15 min |
| §5.5 | `checkHealth` console.error in url-service | M1.4 | 5 min |
| §5.5 | No PUT /urls/:slug | M11 | 1.5h |

**Total estimated effort: ~18.5 hours**

---

*End of plan.*
