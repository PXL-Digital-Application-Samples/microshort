# Implementation Plan — M2: Authentication & Authorization Maturity

> Companion to [PLANNING.md](./PLANNING.md) (§5 → M2) and
> [CODE_REVIEW.md](./CODE_REVIEW.md). This document turns the M2 milestone into a
> concrete, file-level work plan. **M1 is a prerequisite** (reproducible builds,
> all lockfiles committed, Node 26 throughout). M2's goal is: _"turn the
> placeholder auth into something worth teaching with."_

## 0. Scope

M2 resolves exactly these findings and PLANNING.md items:

| # | Tag | Finding | Workstream |
|---|-----|---------|------------|
| CR 2.1 | 🔵 | Admin hard-coded as `user_id === 1`, duplicated x3 | **A** |
| CR 4.1 | 🟠 | Admin-check logic duplicated three ways | **A** |
| CR 2.2 | 🔵 | API keys stored in plaintext | **B** |
| CR 2.4 | 🟠 | Revocation model contradictory (soft schema vs hard DELETE) | **B** |
| CR 2.3 | 🔴 | Key validation writes DB on every call | **B** |
| CR 2.7 | 🔵 | `PUT /config/domain` unauthenticated | **C** |
| — | — | Rate limiting on login and URL creation | **D** |

Explicitly **not** in M2 (do not creep):
- Liveness/readiness split (CR 6.2), graceful shutdown (CR 6.3), structured
  logging/metrics (CR 6.7) → M4.
- File-backed config store, secrets management for `.env` (CR 2.6, §8.2) → M5.
- Analytics-service, 301→302, click rewiring → M3.
- Admin UI runtime config, CDN vendoring → M6.
- Full contract test suites → M7.

### Decisions locked for this plan

1. **Admin bootstrap** — the first registered user is automatically assigned
   `role = 'admin'` (same implicit behaviour as `user_id === 1`, now explicit).
   `createUser()` checks `COUNT(*) = 0` before INSERT; subsequent registrations
   get `role = 'user'`.
2. **Config-write auth** — a shared `CONFIG_WRITE_TOKEN` secret in `.env`.
   Admin-service passes it as `X-Service-Token`; config-service validates it
   locally. No additional HTTP hop. Pattern is consistent with M3's analytics
   `SERVICE_TOKEN`.
3. **Key migration** — existing plaintext keys cannot survive the hash migration.
   Existing databases must be recreated: `docker compose down -v &&
   docker compose up -d`. This is the correct teaching moment for a breaking
   schema change.
4. **API key hashing algorithm** — plain SHA-256 (`crypto.createHash('sha256')`
   from Node built-ins, no extra dependency). SHA-256 is appropriate for
   high-entropy random tokens (`msh_` + 32-char nanoid), unlike passwords which
   need bcrypt/argon2. HMAC-SHA256 with a server-side secret is the M5
   hardening variant (once the secrets story is in place).
5. **Rate limiter version** — `express-rate-limit` v8.x. Uses `limit` (not `max`,
   which was renamed in v7 and is deprecated in v8). In-memory store only — not
   shared across instances. The shared-state limitation is intentional (same
   teaching arc as the per-instance redirect cache) and is resolved in M4.

---

## 1. Current-state facts this plan relies on

Verified against the working tree (commit `8db3285`):

- `auth-service/src/index.js:111,130` — admin check: `keyData.user_id !== 1`.
- `url-service/src/index.js:212,257` — admin check: `authData.userId !== 1`.
- `admin-service/src/index.js:36` — admin check: `data.userId !== 1`.
- `auth-service/src/db.js:47` — `validateApiKey` is `UPDATE api_keys SET
  last_used_at = NOW() WHERE key = ${key} RETURNING id, user_id, name`. Every
  validation call is a write. No `revoked_at` check. No role JOIN.
- `auth-service/src/db.js:36` — `createApiKey` stores the raw key string
  (`msh_${nanoid(32)}`) in `key VARCHAR(64)`.
- `auth-service/src/db.js:69` — `revokeApiKey` does a hard `DELETE`.
- `auth-service/init/01-schema.sql:14` — `key VARCHAR(64) UNIQUE NOT NULL`
  (plaintext).
- `auth-service/init/01-schema.sql:18` — `revoked_at TIMESTAMP` exists but is
  never set (soft-delete schema, hard-delete behaviour).
- `auth-service/init/01-schema.sql` — no `role` column on `users`.
- `config-service/src/server.ts:104` — `// TODO: Add authentication later` on
  `PUT /config/domain`.
- `auth-service`, `url-service` — no `express-rate-limit` dependency.
- `auth-service/src/index.js:48,78` — JWT payload: `{ userId, email }` — no
  `role` claim.
- `auth-service/src/index.js` responds to `POST /auth/validate` with
  `{ valid, userId, keyId }` — no role, no `isAdmin`.
- `admin-service/src/index.js:154` calls config-service's PUT without any
  token: bare `fetch(..., { method: 'PUT', ... })`.

---

## 2. Workstreams

### A — Role model + centralized admin decision (CR 2.1, 4.1)

The load-bearing change is the `POST /auth/validate` response: once it returns
`isAdmin`, consumers (url-service, admin-service) stop computing the admin
decision themselves.

**Files:**
- `auth-service/init/01-schema.sql`
- `auth-service/init/02-migration.sql` ← **NEW**
- `auth-service/src/db.js`
- `auth-service/src/index.js`
- `url-service/src/index.js`
- `admin-service/src/index.js`

#### A1 — Schema: add `role` to `users`

Update `auth-service/init/01-schema.sql` (runs on an empty volume):

```sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

> **M2 requires a database recreate.** The role column (here) and the
> `key → key_hash` rename (workstream B) are breaking schema changes.
> There is **no migration path** — existing plaintext API keys cannot survive
> the hash migration without re-exposure of the plaintext, which defeats the
> purpose. After pulling M2:
> ```
> docker compose down -v && docker compose up -d --build
> ```
> All users and API keys must be re-created. Document this in the commit
> message and in a prominent `NOTE` comment at the top of `01-schema.sql`.

#### A2 — `db.js`: first-registrant admin + role in SELECT

```js
// createUser: first registered user gets role='admin'
export async function createUser(email, passwordHash) {
  const [{ count }] = await sql`SELECT COUNT(*) as count FROM users`;
  const role = parseInt(count) === 0 ? 'admin' : 'user';
  const [user] = await sql`
    INSERT INTO users (email, password_hash, role)
    VALUES (${email}, ${passwordHash}, ${role})
    RETURNING id, email, role, created_at
  `;
  return user;
}

// findUserByEmail: add role to SELECT
export async function findUserByEmail(email) {
  const [user] = await sql`
    SELECT id, email, password_hash, role, created_at
    FROM users WHERE email = ${email}
  `;
  return user;
}
```

> **Race condition caveat**: two simultaneous registrations could both see
> `COUNT = 0` and both become admin. This is negligible in a single-student
> teaching context; note it if the class has multi-user concurrent setup.

#### A3 — `index.js`: role in JWT, `isAdmin` in validate response

JWT signing (both register and login):
```js
jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
```

`/auth/me` response (read role from DB, not just the JWT cache):
```js
res.json({ id: user.id, email: user.email, role: user.role, createdAt: user.created_at });
```

`POST /auth/validate` response — **this is the centralisation point**:
```js
res.json({
  valid: true,
  userId: keyData.user_id,
  keyId: keyData.id,
  role: keyData.role,       // the full string ('user' | 'admin')
  isAdmin: keyData.role === 'admin'  // pre-computed boolean for consumers
});
```

`keyData` now comes from the JOIN-enabled `validateApiKey()` (see workstream B,
which delivers `role` via `JOIN users`).

Auth-service's own admin endpoints (`/admin/users`, `/admin/stats`) use the
local `validateApiKey()` directly — replace the `user_id !== 1` guard:
```js
if (!keyData || keyData.role !== 'admin') {
  return res.status(403).json({ error: 'Admin access required' });
}
```

#### A4 — url-service + admin-service: consume `isAdmin`

**url-service `src/index.js`** — two admin endpoints (`/admin/urls`,
`/admin/stats`):
```js
// Before:
if (authData.userId !== 1) { ... }

// After:
if (!authData.isAdmin) { ... }
```

Also update the `validateApiKey` middleware to carry `role` onto `req.user`:
```js
req.user = { id: data.userId, role: data.role };
```

**admin-service `src/index.js`** — `validateAdminKey` middleware:
```js
// Before:
if (data.userId !== 1) { ... }

// After:
if (!data.isAdmin) { ... }
```
The `req.admin` object can be extended similarly if needed later.

**Verify:**
- Register user A (first), register user B. A can call `/admin/users`; B gets 403.
- Promote B via `UPDATE users SET role='admin' WHERE email='b@...'` in auth-db
  psql; revoke B's old API key and generate a new one; B can now call admin
  endpoints. This teaches that the role is read at key-validation time.

---

### B — API key hashing + revocation fix + last_used_at decoupling (CR 2.2, 2.4, 2.3)

All three findings converge on `auth-service/src/db.js`. They are implemented
together to produce a single coherent final state for `validateApiKey()`.

**Files:**
- `auth-service/init/01-schema.sql`
- `auth-service/src/db.js`

#### B1 — Schema: `key` → `key_hash`

In `01-schema.sql`, replace the `api_keys` table definition:

```sql
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash CHAR(64) UNIQUE NOT NULL,   -- SHA-256 hex of the plaintext key
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user_id  ON api_keys(user_id);
```

Remove the old `idx_api_keys_key` index definition. `CHAR(64)` matches the
SHA-256 hex output exactly (always 64 characters).

> **Migration**: no SQL migration covers this column rename while preserving
> existing keys (you cannot hash a plaintext stored in the DB and produce the
> same hash as the client would use — the client only knows the plaintext).
> **Existing databases must be recreated**: `docker compose down -v &&
> docker compose up -d`.

#### B2 — `db.js`: the final `validateApiKey()` + supporting functions

Add a module-level hash helper (Node built-in `crypto` — no new dependency):

```js
import { createHash } from 'crypto';

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}
```

**`createApiKey`** — hash before storing; return plaintext key for one-time display:
```js
export async function createApiKey(userId, name) {
  const key = `msh_${nanoid(32)}`;
  const keyHash = hashKey(key);
  const [apiKey] = await sql`
    INSERT INTO api_keys (user_id, key_hash, name)
    VALUES (${userId}, ${keyHash}, ${name})
    RETURNING id, name, created_at
  `;
  // Return the plaintext key exactly once — it is never stored.
  return { ...apiKey, key };
}
```

The `POST /auth/api-keys` handler response is unchanged (`apiKey.key` is still
the plaintext value). The UI/CLI still sees `msh_…` once at creation.

**`validateApiKey`** — the unified final form (covers CR 2.2, 2.3, 2.4, and
the role JOIN from workstream A):
```js
export async function validateApiKey(key) {
  const keyHash = hashKey(key);
  const [keyData] = await sql`
    SELECT k.id, k.user_id, u.role
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ${keyHash}
      AND k.revoked_at IS NULL
  `;
  if (keyData) {
    // Fire-and-forget: decouple last_used_at from the hot path (CR 2.3).
    // Validation is now a pure read; the UPDATE happens asynchronously.
    sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${keyData.id}`
      .catch(err => console.error('last_used_at update failed:', err));
  }
  return keyData; // { id, user_id, role } or undefined
}
```

Three CR findings resolved in one function:
- **CR 2.2** — `WHERE key_hash = hashKey(incomingKey)` (no plaintext in DB).
- **CR 2.4** — `AND k.revoked_at IS NULL` (revoked keys are rejected).
- **CR 2.3** — SELECT first (read path), then fire-and-forget UPDATE.
- **CR 2.1/4.1** — `JOIN users u` (role returned for centralised admin check).

**`revokeApiKey`** — soft-delete (CR 2.4):
```js
export async function revokeApiKey(userId, keyId) {
  const [result] = await sql`
    UPDATE api_keys
    SET revoked_at = NOW()
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  return result; // undefined if key not found or already revoked
}
```

**`getUserApiKeys`** — exclude revoked keys (consistent with prior hard-delete
behaviour; users only see active keys):
```js
export async function getUserApiKeys(userId) {
  const keys = await sql`
    SELECT id, name, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
  return keys;
}
```

**`getAuthStats`** — `WHERE revoked_at IS NULL` now actually works (was a no-op
before because revocation was a hard DELETE). No code change needed, but it's
worth noting in the commit message that this filter is now meaningful.

**Verify:**
- Create an API key; use it successfully.
- Revoke it; subsequent calls with that key return 401.
- `SELECT * FROM api_keys` in auth-db psql — `key_hash` column shows 64-char
  hex strings, `revoked_at` is set on revoked rows (not deleted).
- Validate three times in quick succession; `last_used_at` updates eventually
  (may lag one cycle) without blocking the response.
- Deliberately corrupt the key (`msh_abc…` → `msh_ABC…`); validation returns
  401 (hash mismatch, not a timing-sensitive string compare).

---

### C — Config-service write authentication (CR 2.7)

**Files:**
- `.env`
- `compose.yml`
- `compose-simple.yml`
- `config-service/src/server.ts`
- `config-service/src/index.test.ts`
- `admin-service/src/index.js`

#### C1 — Add `CONFIG_WRITE_TOKEN` to environment

`.env` (add):
```
CONFIG_WRITE_TOKEN=dev-config-token-change-in-production
```

`compose.yml` — add to both `config-service` and `admin-service` environment
blocks:
```yaml
CONFIG_WRITE_TOKEN: ${CONFIG_WRITE_TOKEN:-dev-config-token-change-in-production}
```

Apply the same change to `compose-simple.yml`.

#### C2 — config-service: check token on PUT

In `server.ts`, add a check at the top of `PUT /config/domain`:

```ts
app.put('/config/domain', async (req: Request, res: Response): Promise<void> => {
  const expected = process.env.CONFIG_WRITE_TOKEN;
  if (!expected || req.headers['x-service-token'] !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // rest of handler unchanged
  const { domain } = req.body;
  ...
});
```

Update the OpenAPI JSDoc comment for the PUT endpoint to document the header:
```
 *     security:
 *       - serviceToken: []
 *     parameters:
 *       - in: header
 *         name: X-Service-Token
 *         required: true
 *         schema:
 *           type: string
```

#### C3 — admin-service: forward the token

In `admin-service/src/index.js`, the `PUT /admin/config` handler calls
config-service. Add the token header:

```js
const response = await fetch(`${CONFIG_SERVICE_URL}/config/domain`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'X-Service-Token': process.env.CONFIG_WRITE_TOKEN || ''
  },
  body: JSON.stringify({ domain }),
  signal: AbortSignal.timeout(2000)
});
```

Add `CONFIG_SERVICE_WRITE_TOKEN` (or just `CONFIG_WRITE_TOKEN`) to
admin-service's env reading — both services use the same variable name so the
token is shared from a single `.env` entry.

#### C4 — Update config-service tests

The current `src/index.test.ts` uses vitest + supertest. The `beforeEach`
already sets `CONFIG_PATH` to a temp file and calls `__resetConfigCache()`;
`afterEach` deletes `CONFIG_PATH` and removes the temp file.

Add `CONFIG_WRITE_TOKEN` to the existing setup/teardown:
```ts
beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(tmp, JSON.stringify({ domain: 'https://fixture.test' }));
  process.env.CONFIG_PATH = tmp;
  process.env.CONFIG_WRITE_TOKEN = 'test-write-token';  // ADD
  __resetConfigCache();
});

afterEach(async () => {
  delete process.env.CONFIG_PATH;
  delete process.env.CONFIG_WRITE_TOKEN;                 // ADD
  await fs.rm(tmp, { force: true });
});
```

Update the existing `'PUT /config/domain should update domain'` test to send
the token (the test uses supertest's chained `.set()` before `.send()`):
```ts
it('PUT /config/domain should update domain', async () => {
  const newDomain = 'https://test.example';
  const response = await request(app)
    .put('/config/domain')
    .set('X-Service-Token', 'test-write-token')   // ADD
    .send({ domain: newDomain });
  expect(response.status).toBe(200);
  expect(response.body.domain).toBe(newDomain);

  const getResponse = await request(app).get('/config/domain');
  expect(getResponse.body.domain).toBe(newDomain);
});
```

Add two new tests inside the existing `describe('ConfigService', ...)` block:
```ts
it('PUT /config/domain should reject a missing token', async () => {
  const response = await request(app)
    .put('/config/domain')
    .send({ domain: 'https://evil.test' });
  expect(response.status).toBe(401);
});

it('PUT /config/domain should reject a wrong token', async () => {
  const response = await request(app)
    .put('/config/domain')
    .set('X-Service-Token', 'wrong-token')
    .send({ domain: 'https://evil.test' });
  expect(response.status).toBe(401);
});
```

**Verify:**
- `curl -X PUT http://localhost:3000/config/domain -d '{"domain":"x"}'` → 401.
- Same call with `X-Service-Token: dev-config-token-change-in-production` → 200.
- `PUT /admin/config` (admin API key) → updates domain correctly (admin-service
  forwards the token transparently).
- `npx vitest run` in config-service → all tests green.

---

### D — Rate limiting (PLANNING.md §5/M2)

**Files:**
- `auth-service/package.json`, `auth-service/package-lock.json`
- `auth-service/src/index.js`
- `url-service/package.json`, `url-service/package-lock.json`
- `url-service/src/index.js`

#### D1 — Add dependency

```bash
cd services/auth-service && npm install express-rate-limit
cd services/url-service  && npm install express-rate-limit
```

This updates `package.json` (adds `"express-rate-limit": "^8.0.0"`) and
regenerates `package-lock.json`. Commit both files.

#### D2 — auth-service: login + register limiter

```js
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  limit: 10,                   // 10 attempts per IP per window
  standardHeaders: 'draft-6',  // separate RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers
  legacyHeaders: false,        // disable X-RateLimit-* (deprecated)
  message: { error: 'Too many attempts, please try again later' }
});

app.post('/auth/login',    authLimiter, async (req, res) => { ... });
app.post('/auth/register', authLimiter, async (req, res) => { ... });
```

Apply the limiter as the **first** argument after the path — before any async
work — so blocked requests are rejected without touching the DB.

#### D3 — url-service: URL creation limiter

```js
import rateLimit from 'express-rate-limit';

const urlCreateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1-minute window
  limit: 30,             // 30 new URLs per IP per minute
  standardHeaders: 'draft-6',  // separate RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

app.post('/urls', urlCreateLimiter, validateApiKey, async (req, res) => { ... });
```

The limiter sits **before** `validateApiKey` — reject rate-limited requests
before spending an HTTP round-trip to auth-service.

#### D4 — Known limitation (intentional)

The in-memory store is per-instance. Under horizontal scaling, each replica
has its own counter, so limits apply per-instance rather than globally. This
is the same teaching arc as the per-instance redirect cache: students observe
the limit bypassed by round-robining replicas, then M4 replaces the memory
store with a Redis-backed store. **Do not pre-solve this in M2.**

If the services ever sit behind a proxy (nginx, Traefik), add
`app.set('trust proxy', 1)` so `req.ip` reflects the real client rather than
the proxy IP. For the bare Docker Compose setup this is not needed, but the
comment in the code is worth leaving.

**Verify:**
- Send 11 POST `/auth/login` requests in a 15-minute window → 11th returns 429
  with `RateLimit-*` headers.
- Send 31 POST `/urls` requests in one minute → 31st returns 429.
- Stopping and restarting the service resets counters (expected, and part of
  the lesson).

---

## 3. File-change summary

| File | Workstream | Change |
|------|-----------|--------|
| `auth-service/init/01-schema.sql` | A + B | Add `role` to `users`; replace `key` with `key_hash CHAR(64)` on `api_keys`; update index; add recreate note |
| `auth-service/src/db.js` | A + B | `createUser` (role), `findUserByEmail` (role), `createApiKey` (hash), `validateApiKey` (SELECT + JOIN + revocation + async update), `revokeApiKey` (soft-delete), `getUserApiKeys` (filter revoked) |
| `auth-service/src/index.js` | A + D | JWT role claim; `/auth/validate` returns `isAdmin`+`role`; admin guards use `role !== 'admin'`; rate limiter on login+register |
| `auth-service/package.json` | D | Add `express-rate-limit` |
| `auth-service/package-lock.json` | D | Regenerate after above |
| `url-service/src/index.js` | A + D | Admin guards use `!authData.isAdmin`; rate limiter on `POST /urls`; `req.user` carries `role` |
| `url-service/package.json` | D | Add `express-rate-limit` |
| `url-service/package-lock.json` | D | Regenerate |
| `admin-service/src/index.js` | A + C | Admin guard uses `!data.isAdmin`; config PUT forwards `X-Service-Token` |
| `config-service/src/server.ts` | C | Token check on `PUT /config/domain`; updated Swagger docs |
| `config-service/src/index.test.ts` | C | Token in PUT test; two new 401 tests |
| `.env` | C | Add `CONFIG_WRITE_TOKEN` |
| `compose.yml` | C | Add `CONFIG_WRITE_TOKEN` to config-service + admin-service |
| `compose-simple.yml` | C | Same as above |

---

## 4. Commit sequencing

Recommended order to keep each commit buildable and the git history readable:

1. **Schema** — update `01-schema.sql` (role column + key_hash rename + recreate
   note). Document the `down -v` requirement prominently in the commit message.
2. **auth-service `db.js`** — all DB functions: `createUser`, `findUserByEmail`,
   `hashKey`, `createApiKey`, `validateApiKey`, `revokeApiKey`,
   `getUserApiKeys`.
3. **auth-service `index.js`** — JWT role claim, `/auth/validate` response,
   admin guards, rate limiter + `express-rate-limit` dep + new lockfile.
4. **url-service** — `isAdmin` guards, rate limiter, dep + lockfile.
5. **admin-service** — `isAdmin` guard, config-PUT token forwarding.
6. **config-service** — `server.ts` token check, test updates, Swagger docs.
7. **compose / `.env`** — `CONFIG_WRITE_TOKEN` env vars.

Full-stack smoke test after step 7 before tagging M2 complete.

---

## 5. Definition of done (M2 acceptance criteria)

- [ ] **CR 2.1 / 4.1** — `user_id !== 1` / `userId !== 1` appears in zero
  files in the `services/` tree
  (`grep -rn 'userId.*!== 1\|user_id.*!== 1' services` returns nothing). The
  first registered user is admin; the second is not. All three services (auth,
  url, admin) determine "is admin" by checking `isAdmin`/`role` from
  `POST /auth/validate`.
- [ ] **CR 2.2** — `SELECT key FROM api_keys` returns only 64-char hex strings
  (hashes). `grep -rn "'key'" services/auth-service/src/db.js` shows no direct
  key-column writes.
- [ ] **CR 2.4** — `revokeApiKey` sets `revoked_at`; revoked keys return 401
  on validation; `getAuthStats` counts only `revoked_at IS NULL`.
- [ ] **CR 2.3** — `validateApiKey` body contains no `await` on the
  `last_used_at` UPDATE (`grep -A5 'last_used_at' services/auth-service/src/db.js`
  shows a `.catch`-terminated, non-awaited promise).
- [ ] **CR 2.7** — `curl -X PUT http://localhost:3000/config/domain -d
  '{"domain":"x"}'` returns 401. The same request with the correct
  `X-Service-Token` returns 200. `PUT /admin/config` (admin key) updates the
  domain correctly end-to-end.
- [ ] **Rate limiting** — 11th login in 15 min returns 429; 31st URL creation
  in 1 min returns 429. Responses include `RateLimit-Limit`,
  `RateLimit-Remaining`, and `RateLimit-Reset` headers (draft-6 format).
- [ ] **Tests** — `cd services/config-service && npx vitest run` passes; new
  401 tests are included; tree stays clean after the run.
- [ ] **Full stack** — `docker compose up -d --build` (after `down -v`) brings
  all services healthy; the happy path (register → API key → shorten → redirect
  → admin dashboard) works end-to-end.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| First-user race condition (two simultaneous registrations, both see `COUNT=0`, both become admin). | Negligible in teaching context. Document in code comment. Production fix: DB trigger or `INSERT … ON CONFLICT` + a separate `system_settings` flag. |
| JWT role claim goes stale if a user's role changes after token issuance. | Acceptable for 7-day tokens in a teaching environment. Note in commit message. Fix path: shorter token TTL or role-re-verification per request (M4 concern). |
| `CONFIG_WRITE_TOKEN` stored in plaintext `.env`. | Deliberate: M5 addresses secret injection. Add a loud comment in `.env` and the Swagger docs. |
| Rate limiter bypassed by horizontal scaling (each replica has its own counter). | Intentional — same teaching arc as per-instance redirect cache. Resolved in M4 with Redis store. |
| `constant-time` comparison not used for the service token check. | `timing-safe-equal` from Node `crypto` is the hardening fix. Note in code; M5 is the right milestone to address it alongside the full secrets story. |
| `express-rate-limit@8.x` `limit` option vs. older `max`. | Use `limit` (not `max`) to avoid the deprecation warning. Verified against current v8 docs. |
| Existing running databases after schema change. | Document `docker compose down -v` requirement prominently in commit message and `02-migration.sql` header. |

---

## 7. Out of scope (deferred, do not creep)

Analytics-service + 301→302 + click rewiring (M3); liveness/readiness,
structured logging, Prometheus metrics, graceful shutdown, shared Redis cache
(M4); config backing store, `.env` → secrets injection, `HMAC-SHA256` key
hardening (M5); admin-UI runtime config, CDN vendoring (M6); doc reconciliation,
full contract test suites (M7).

---

*Sources consulted while writing this plan:*
- [express-rate-limit npm](https://www.npmjs.com/package/express-rate-limit) — confirmed v8.x, `limit` replaces `max`
- [express-rate-limit configuration reference](https://express-rate-limit.mintlify.app/reference/configuration)
- [SHA-256 vs HMAC-SHA256 for API keys](https://mojoauth.com/compare-hashing-algorithms/sha-256-vs-hmac-sha256/) — SHA-256 is correct for high-entropy tokens; HMAC is the next hardening step
