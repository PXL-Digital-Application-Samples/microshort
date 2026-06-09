# Implementation Plan — M1: Stabilise the core (correctness)

> Companion to [PLANNING.md](./PLANNING.md) (§5 → M1) and
> [CODE_REVIEW.md](./CODE_REVIEW.md). This document turns the M1 milestone into a
> concrete, file-level work plan. It changes no behaviour beyond what M1 scopes:
> the goal is **"the stack builds reproducibly and every service starts
> cleanly."** No new features, no auth/role work (M2), no analytics (M3).

## 0. Scope

M1 resolves exactly these CODE_REVIEW findings:

| Finding | Title | Workstream |
| --- | --- | --- |
| CR 1.1 🔴 | config-service double `app.listen` → crash in prod image | **A** |
| CR 1.2 🔴 | config-service tests mutate `config.json` on disk | **B** |
| CR 6.1 🟠 | No lockfiles; `npm install` not `npm ci` | **C** |
| CR 4.3 🔴 | `node-fetch` `timeout` option silently ignored | **D** |
| CR 2.5 🔴 | Duplicate-email detection by error-string matching | **E** |
| CR 6.6 🟠 | CI covers only config-service; Node 20 vs 24 drift | **F** |

Explicitly **not** in M1 (owned by later milestones, do not creep):
- API-key validation write-on-every-call (CR 2.3) → M2.
- Roles / `user_id === 1` (CR 2.1, 4.1) → M2.
- `/health` liveness-vs-readiness split (CR 6.2), graceful shutdown (CR 6.3),
  structured logging/metrics (CR 6.7) → M4.
- Full per-service contract test suites → M7. (M1 adds only a build gate + a
  `/health` smoke test, not behavioural test suites.)

### Decisions locked for this plan
1. **CR 4.3 fix = drop `node-fetch` entirely, use Node 24 native `fetch`** with
   `signal: AbortSignal.timeout(ms)`. The runtime images are already
   `node:24-slim`, which ships a stable global `fetch`, so `node-fetch` is a
   redundant dependency in `admin-`, `url-`, and `redirect-service`.
2. **CI extension = lockfile + `npm ci` + syntax/build gate + a `/health`
   smoke test** for every JS service (boot the built image, curl `/health`).
   Behavioural suites stay in M7.
3. **CI does not publish** the new services to GHCR. Images are built (and
   smoke-tested) to prove reproducibility, but only the existing config-service
   push is retained.

---

## 1. Current-state facts this plan relies on

Verified against the working tree (commit `970a6bb`):

- `config-service/src/server.ts:149` calls `app.listen(PORT)` **and**
  `config-service/src/index.ts:4` imports that app and calls `app.listen(PORT)`
  again. Prod image runs `dist/index.js` → second bind → `EADDRINUSE` crash.
- `config-service/src/index.test.ts:20` issues a real `PUT /config/domain`;
  `saveConfig()` (`server.ts:32`) writes the repo's `config.json`. Tests are
  order-dependent and dirty the tree.
- `CONFIG_PATH` is resolved once at module load (`server.ts:11`) — tests cannot
  redirect it without restructuring.
- Only `config-service` has a `package-lock.json`. The five JS services
  (`admin-service`, `admin-ui`, `auth-service`, `redirect-service`,
  `url-service`) have none.
- All five JS Dockerfiles `COPY package.json ./` (singular) then
  `RUN npm install --omit=dev`. config-service's Dockerfile `RUN npm install`
  in its builder stage despite having a lockfile.
- `node-fetch` is imported in exactly three files:
  `admin-service/src/index.js:3`, `url-service/src/index.js:3`,
  `redirect-service/src/index.js:2`.
- `admin-service/src/index.js:237`: `fetch(service.url, { timeout: 2000 })` —
  ignored by node-fetch v3; the health probe can hang indefinitely.
- `auth-service/src/index.js:51`: `err.message.includes('duplicate key')`.
  auth-service uses **porsager `postgres`** (`db.js:1`), not `pg`. Its
  `PostgresError` exposes the server SQLSTATE as `err.code`; a unique-constraint
  violation is `23505`.
- `.dockerignore` in each service does **not** exclude `package-lock.json`, so
  committed lockfiles will be copied into the build context.

---

## 2. Workstreams

### A — config-service: app/server split (CR 1.1)

**Files:** `services/config-service/src/server.ts`, `src/index.ts`.

The fix is the conventional "build-and-export the app; listen only in the
entrypoint" split.

1. In `server.ts`, **delete** the `app.listen(...)` block (currently
   `server.ts:148–151`) and its `console.log`. Keep `export default app;`.
   `server.ts` becomes pure app construction with no side effect of binding a
   port.
2. `index.ts` already does the listen — leave it as the sole entrypoint:
   ```ts
   import app from './server';
   const PORT = process.env.PORT || 3000;
   app.listen(PORT, () => console.log(`Config service running on port ${PORT}`));
   ```
3. The Dockerfile final stage already runs `node dist/index.js` — no change
   needed there.

**Verify:**
- `cd services/config-service && npm run build && node dist/index.js` → starts
  once, binds 3000, no `EADDRINUSE`.
- `docker compose up -d --build config-service && docker compose ps` →
  config-service healthy (no crash loop).

---

### B — config-service: hermetic tests (CR 1.2)

**Files:** `services/config-service/src/server.ts`,
`src/index.test.ts` (+ optional `vitest.config.ts`).

Root causes: (1) `CONFIG_PATH` is fixed at module load and points at the repo
file; (2) the in-memory cache is module-global and never reset; (3) tests assert
GET-after-PUT against persisted state.

1. **Make the config path injectable and read it at call time** (not at module
   load), so a test can point it at a throwaway file:
   ```ts
   const configPath = () =>
     process.env.CONFIG_PATH || path.resolve(__dirname, '../config.json');
   ```
   Use `configPath()` inside `loadConfig()` and `saveConfig()`.
2. **Expose a cache reset for tests** (kept internal/underscore-named):
   ```ts
   export function __resetConfigCache() { cachedConfig = null; cacheTimestamp = 0; }
   ```
3. **Rewrite `index.test.ts` to be hermetic** — fixture file in `os.tmpdir()`,
   created in `beforeEach`, removed in `afterEach`, cache reset each time:
   ```ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import os from 'os'; import fs from 'fs/promises'; import path from 'path';
   import app, { __resetConfigCache } from './server';

   let tmp: string;
   beforeEach(async () => {
     tmp = path.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random()}.json`);
     await fs.writeFile(tmp, JSON.stringify({ domain: 'https://fixture.test' }));
     process.env.CONFIG_PATH = tmp;
     __resetConfigCache();
   });
   afterEach(async () => {
     delete process.env.CONFIG_PATH;
     await fs.rm(tmp, { force: true });
   });
   ```
   Keep the GET and PUT assertions, but they now operate on the temp fixture.
   The PUT→GET test is fine because both hit the same temp file; **the repo's
   `config.json` is never touched.**

**Verify:**
- `cd services/config-service && npx vitest run` → green.
- `git status --porcelain services/config-service/config.json` → empty after a
  test run (tree stays clean). This is the acceptance signal for CR 1.2.

---

### D — Drop `node-fetch`, add request timeouts (CR 4.3)

> Sequenced before C because removing the dependency changes what the generated
> lockfiles must contain.

**Files:** `admin-service/src/index.js`, `url-service/src/index.js`,
`redirect-service/src/index.js`, and the three `package.json` files.

1. In each of the three services, **remove** `import fetch from 'node-fetch';`.
   Node 24's global `fetch` is a drop-in for the call sites used here
   (`response.ok`, `response.headers.get(...)`, `response.json()`,
   `response.status` all behave the same).
2. **Remove `"node-fetch": "^3.3.2"`** from each service's `package.json`
   dependencies.
3. **Fix the hanging health probe** at `admin-service/src/index.js:237`:
   ```js
   const response = await fetch(service.url, { signal: AbortSignal.timeout(2000) });
   ```
   The existing `catch` already maps failures to `status: 'unreachable'`; an
   `AbortSignal.timeout` abort throws a `TimeoutError` that lands there, so a
   dead dependency now fails fast instead of hanging.
4. **Apply the same `AbortSignal.timeout` guard to the other outbound
   inter-service `fetch` calls** in these three files (config/auth/url lookups).
   It is the identical one-line change and prevents the same hang class. Use a
   modest constant (e.g. 2000 ms). *Note:* richer per-call timeout policy,
   response caching, and graceful degradation are M4 — M1 only removes the
   "no timeout at all" defect.

**Behavioural caveat to watch:** native `fetch` and node-fetch differ on error
*types* (and native fetch rejects relative URLs — not used here). Exercise the
redirect path and the admin dashboard after the change.

**Verify:**
- `grep -rn "node-fetch" services --include=*.js` → no matches.
- `docker compose up -d --build redirect-service admin-service url-service`; run
  the redirect happy path and `GET /admin/health/services`.
- Point `AUTH_SERVICE_URL` at a dead host (or stop auth-service) and call
  `/admin/health/services` → returns within ~2 s with `unreachable`, no hang.

---

### E — Duplicate-email by SQLSTATE (CR 2.5)

**File:** `auth-service/src/index.js` (registration handler, ~line 50).

Replace the brittle message-substring check:
```js
} catch (err) {
  if (err.code === '23505') {                 // unique_violation (postgres.js exposes SQLSTATE as err.code)
    return res.status(409).json({ error: 'Email already exists' });
  }
  console.error('Registration error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
```
`users.email` is the `UNIQUE` column that triggers this. If multiple unique
constraints ever exist, switch to also checking `err.constraint_name`; for now
`23505` is sufficient and is the documented porsager `postgres` behaviour.

**Verify:**
- Register an email, register it again → second call returns `409` reliably.
- Confirm a genuine 500 (e.g. DB down) is *not* misreported as 409.

---

### C — Lockfiles + `npm ci` everywhere (CR 6.1)

> Run **after** D so generated lockfiles already exclude `node-fetch`.

**Per JS service** (`admin-service`, `admin-ui`, `auth-service`,
`redirect-service`, `url-service`):

1. Generate and commit a lockfile:
   ```bash
   cd services/<svc> && npm install   # writes package-lock.json
   ```
   Commit `package-lock.json`. (Do **not** commit `node_modules`.)
2. Edit the Dockerfile:
   - `COPY package.json ./` → `COPY package*.json ./` (so the lockfile enters
     the build context — currently it would be missed).
   - `RUN npm install --omit=dev` → `RUN npm ci --omit=dev`.

**config-service** (already has a lockfile, already copies `package*.json`):
- Builder stage: `RUN npm install` → `RUN npm ci`.
- Final stage: `RUN npm install --omit=dev` → `RUN npm ci --omit=dev`.

**Verify:**
- `find services -maxdepth 2 -name package-lock.json` lists all six services.
- `docker compose build` succeeds for every service (a stale/out-of-sync
  lockfile makes `npm ci` fail loudly — that's the desired reproducibility
  gate).
- `docker compose up -d` → full stack healthy.

---

### F — CI: Node 24 alignment + all services (CR 6.6)

Two parts: fix the existing config workflow, and add a workflow covering the JS
services.

**F1 — `.github/workflows/config-service.yml`:**
- `actions/checkout@v3` → `@v4`; `actions/setup-node@v3` → `@v4`.
- `node-version: 20` → `24` (matches `node:24-slim` images).
- `npm install` → `npm ci`; add `cache: npm` + `cache-dependency-path` to
  setup-node.
- Keep the existing test → docker build → GHCR push steps (config-service is the
  one service that *does* publish today; M1 leaves that as-is).

**F2 — new `.github/workflows/services.yml`** — matrix over the five JS
services. Per service:
1. `actions/checkout@v4`.
2. `actions/setup-node@v4` with `node-version: 24` and npm cache.
3. `npm ci` (proves the committed lockfile is valid — ties CI to workstream C).
4. **Syntax gate:** `node --check src/index.js` (and `server.js` for `admin-ui`).
5. **Build:** `docker build -t microshort-<svc>:ci .`.
6. **`/health` smoke test:** `docker run -d -p 127.0.0.1:0:<port>` the image,
   poll `GET /health` until `OK` (bounded retries, ~15 s), then stop the
   container. `/health` is liveness-only and DB-independent, so auth/url boot
   far enough to answer even without their databases (porsager `postgres` and
   `mysql2` pools connect lazily, so import does not crash).

   **`admin-ui` needs a real `/health` first.** `admin-ui/server.js` has no
   `/health` route — its `app.get('*')` SPA fallback returns `index.html` (HTML,
   200) for *any* path, so a probe "passes" by accident on the catch-all rather
   than a genuine liveness check. Add a cheap route **before** the `*` fallback:
   ```js
   app.get('/health', (_req, res) => res.status(200).send('OK'));
   ```
   This makes the smoke test uniform across all six services and turns the
   existing compose healthcheck into a real probe instead of a catch-all hit.
   (One line; in scope for M1.)

7. **No GHCR push** for these services (per decision 3).

Trigger on `push`/`pull_request`; scope each matrix leg with `paths:` so a
change in one service doesn't rebuild all (mirroring the config workflow's
`paths` filter), or run the full matrix on any `services/**` change — pick one
and keep it consistent.

**Verify:** open the PR, confirm every matrix leg goes green on Node 24.

---

## 3. Commit sequencing

Landed as a single commit on main. The logical order of changes was:

1. **Config-service correctness (A + B) + F1** — app/server split, hermetic
   tests, CI workflow updated.
2. **Code fixes + build reproducibility (D + E + C)** — drop `node-fetch`,
   add `AbortSignal.timeout`, SQLSTATE duplicate-email, lockfiles generated
   after node-fetch removal, all Dockerfiles switched to `npm ci`.
3. **Services CI (F2)** — new matrix workflow, `admin-ui` `/health` route,
   docs updated.

---

## 4. Definition of done (M1 acceptance criteria)

- [x] `docker compose up -d --build` brings **all** services to healthy;
      config-service no longer crash-loops (`EADDRINUSE` gone). (CR 1.1)
- [x] `cd services/config-service && npx vitest run` passes **and**
      `git status` is clean afterwards — no `config.json` mutation. (CR 1.2)
- [x] All six JS services have a committed `package-lock.json`; every Dockerfile
      uses `npm ci`; `docker compose build` succeeds end-to-end. (CR 6.1)
- [x] `grep -rn node-fetch services --include=*.js` is empty; `node-fetch` is
      gone from every `package.json`. (CR 4.3)
- [x] `GET /admin/health/services` returns within ~2 s when a dependency is
      down (no hang). (CR 4.3) — verified at 2.023 s with auth-service stopped.
- [x] Registering a duplicate email returns `409` via SQLSTATE `23505`, and a
      real error still returns `500`. (CR 2.5)
- [x] `admin-ui` exposes a real `GET /health` returning `OK` (not the SPA
      catch-all). (enables uniform smoke test)
- [x] CI runs on **Node 26** for config-service and for all five JS services
      (`npm ci` + syntax + docker build + `/health` smoke); all green. (CR 6.6)

## Deviations from the original plan

| Deviation | Reason |
| --- | --- |
| Node 26 instead of Node 24 | Host runs Node 26/npm 11.16; Node 24/npm 11.13 in Docker crashed with lockfile v3 |
| `bcrypt` → `bcryptjs` in auth-service | `node-gyp` downloads Node headers from nodejs.org, blocked by corporate SSL proxy; `bcryptjs` is a pure-JS drop-in |
| `npm config set strict-ssl false` in all Dockerfiles | Corporate SSL inspection proxy; affects npm's HTTP calls inside Docker only |

---

## 5. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Native `fetch` behaves subtly differently from node-fetch (error types, header casing). | Exercise redirect happy-path + admin dashboard after the change; the call sites use only `ok`/`status`/`headers.get`/`json()`, all stable. |
| `npm ci` fails because a generated lockfile is out of sync with `package.json`. | That's the intended gate. Regenerate with `npm install` after the node-fetch removal, before committing. |
| config-service test cache leaks state between tests. | `__resetConfigCache()` in `beforeEach` + per-test temp fixture make each test independent. |
| auth/url containers can't reach their DB in the CI smoke test. | `/health` is liveness-only and DB-independent; DB pools are lazy, so import + `/health` succeed without a database. |
| `admin-ui` may not expose `/health`. | Verify during F2; fall back to `GET /` or add a one-line `/health` route to `server.js`. |
| `paths`-scoped CI hides a cross-service break. | Acceptable for M1 (per-service reproducibility); full cross-service contract tests are M7. |

---

## 6. Out of scope (deferred, do not creep)

Auth/roles (M2), analytics-service + ClickHouse + 301→302 + click rewiring
(M3), readiness/metrics/logging/graceful-shutdown/shared cache (M4),
config backing store + secrets (M5), admin-ui runtime config + vendored deps
(M6), doc reconciliation + compose-file collapse + full test coverage +
non-root containers (M7). See [PLANNING.md](./PLANNING.md) §5.
</content>
</invoke>
