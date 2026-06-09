# Code Review — microshort

> Status: **planning-stage review**. This document only *describes* the current
> state of the codebase. No code is changed as a result of it. Fixes and
> follow-up work are sequenced in [PLANNING.md](./PLANNING.md).
>
> Reviewed at commit `81a6c0b` (2026-06-09). The project is a deliberately
> unfinished teaching artifact: not everything described is implemented, and not
> everything implemented is wired up. Findings below are tagged so the genuinely
> broken items are not confused with choices that are intentional teaching
> material.

## Legend

| Tag | Meaning |
| --- | --- |
| 🔴 **BUG** | Incorrect behaviour or a crash. Should be fixed. |
| 🟠 **INCONSISTENCY** | Code, schema, and docs disagree; or the same logic is implemented several different ways. |
| 🟡 **GAP** | Half-implemented / stubbed feature waiting to be finished. |
| 🔵 **DESIGN** | A deliberate trade-off / teaching opportunity (scaling, auth, secrets, monitoring). Still planned for resolution in PLANNING.md — taught by fixing it, not left as-is. |

---

## 1. Show-stoppers

### 1.1 🔴 config-service starts the HTTP server twice
`services/config-service/src/server.ts:149` calls `app.listen(PORT)` at module
load time, and `src/index.ts:4` imports that same `app` and calls
`app.listen(PORT)` **again**. The production image runs `dist/index.js`
(`Dockerfile` final stage), so the service binds port 3000 twice → the second
bind throws `EADDRINUSE` and the container crashes on boot.

The conventional fix is the "app vs. server" split: `server.ts` should *build and
export* the app without listening; only `index.ts` listens. Right now `server.ts`
both exports the app (for tests) *and* listens, which is the root of the problem.

### 1.2 🔴 config-service tests mutate the repo's `config.json`
`src/index.test.ts:20` issues a real `PUT /config/domain` with
`https://test.example`, and `saveConfig()` (`server.ts:32`) writes that to
`config.json` on disk. Consequences:
- Running `npm test` leaves the working tree dirty (`config.json` changed).
- The tests are order-dependent (the GET test passes only because a PUT ran
  earlier) and non-idempotent.
- There is no fixture/teardown to restore the file.

Because the config-service `Dockerfile` runs `npx vitest run` during the build,
this also couples image builds to this stateful behaviour.

---

## 2. Authentication & authorization

### 2.1 🔵 Admin is hard-coded as `user_id === 1`
`auth-service/src/index.js:111`, `url-service/src/index.js:211`,
`admin-service/src/index.js:36`. Whoever registers first becomes the
administrator, implicitly. There is no role concept in the schema or the JWT.
The same `userId !== 1` check is re-implemented in three services. This is a
natural **auth teaching exercise** (introduce roles / claims) but as written it
is fragile and duplicated.

### 2.2 🔵 API keys are stored in plaintext
`auth-service/init/01-schema.sql:14` (`key VARCHAR(64) UNIQUE`) and
`db.js:36` store the raw `msh_…` key. Best practice is to store only a hash and
compare on validation. Good material for the auth module.

### 2.3 🔴 API-key validation writes to the database on every call
`auth-service/src/db.js:47` `validateApiKey` is an `UPDATE … SET last_used_at =
NOW() … RETURNING`. Every redirect lookup, every URL operation, and every admin
call therefore performs a write against auth-db. This is a correctness-adjacent
scaling bug: validation is not idempotent, can't use read replicas, and becomes
a write hotspot under load. (Doubles as a **scaling teaching** moment, but should
at least be decoupled from the hot path.)

### 2.4 🟠 Revocation model is contradictory
The schema defines `api_keys.revoked_at` (`01-schema.sql:18`) and
`getAuthStats()` counts `WHERE revoked_at IS NULL` (`db.js:109`), implying a soft
delete. But `revokeApiKey()` (`db.js:69`) does a hard `DELETE`. So `revoked_at`
is never set, the stats filter is a no-op, and `validateApiKey` never checks
revocation at all. Pick one model.

### 2.5 🔴 Duplicate-email detection by string matching
`auth-service/src/index.js:51` decides "email already exists" via
`err.message.includes('duplicate key')`. This depends on the exact Postgres
driver error text. Check the SQL state / constraint name instead.

### 2.6 🔵 `JWT_SECRET` and DB passwords are committed
`.env` contains `JWT_SECRET=dev-secret-change-in-production` and the DB
passwords, and the same default is hard-coded in `auth-service/src/index.js:9`.
Intentional for a one-command start, but this is exactly the **secrets-management
teaching** surface — flag it loudly rather than leaving it silent.

### 2.7 🔵 config PUT is unauthenticated
`config-service/src/server.ts:104` has `// TODO: Add authentication later`.
Anything that can reach config-service on the internal network can change the
domain. `admin-service` gates its own `PUT /admin/config` behind the admin key,
but config-service itself is open.

---

## 3. Click counting & analytics (mostly 🟡)

### 3.1 🔴 Clicks are counted on lookup, not on visit, and the cache hides most visits
`url-service/src/index.js:132` increments the click counter inside
`GET /urls/:slug`. But `redirect-service` caches each slug for 5 minutes
(`redirect-service/src/index.js:11`), so the *second through Nth* visit within
that window never reaches url-service and is never counted. Conversely, an admin
or direct API fetch of the slug inflates the count. "Lookup" and "visit" are
conflated.

### 3.2 🟡 `url_analytics` table is defined but never written
`url-service/init/01-schema.sql:16` defines `url_analytics`
(`referrer`, `user_agent`, `ip_hash`, …). Nothing inserts into it.
`redirect-service`'s `logRedirect()` (`index.js:128`) is a `console.log` stub
with a comment "would send to analytics-service". This is the seam where the
planned **Java analytics-service** plugs in — see PLANNING.md.

### 3.3 🔵 301 (permanent) redirects fight analytics
`redirect-service/src/index.js:124` returns `301`. Browsers and proxies cache a
301 indefinitely, so after the first visit a client may never hit the service
again — destroying click analytics and making it impossible to change a target.
Most shorteners use `302`. Worth a deliberate decision.

---

## 4. Inter-service & data-shape consistency

### 4.1 🟠 Admin authorization logic duplicated three ways
The "is this an admin key" dance (call `/auth/validate`, check `userId === 1`)
is copy-pasted in `url-service` (`index.js:200`), `admin-service`
(`index.js:23`), and partially in `auth-service`. Diverging copies are a
maintenance trap. A shared notion of "admin" belongs in auth-service.

### 4.2 🟠 snake_case vs camelCase across the admin API
`admin-ui/components/Dashboard.js:35` reads `url.long_url` (snake_case, as
returned by url-service `/admin/stats` `topUrls`), while the URLs list view
consumes `longUrl` (camelCase, as returned by admin-service `/admin/urls`). The
API surface mixes conventions, so the UI has to know which shape each endpoint
emits.

### 4.3 🔴 `node-fetch` `timeout` option is silently ignored
`admin-service/src/index.js:237` calls `fetch(service.url, { timeout: 2000 })`.
node-fetch v3 removed the `timeout` option; timeouts now require an
`AbortController`/`AbortSignal`. The service-health check therefore has no
timeout and can hang on an unreachable dependency.

### 4.4 🟡 Stubbed admin endpoints
`admin-service/src/index.js:139` `GET /admin/users/:userId` returns `501 Not
Implemented` by design. `GET /admin/search/urls` (`index.js:194`) fetches *all*
URLs (`LIMIT 1000`) and filters in memory — acknowledged in a comment as
non-scalable.

---

## 5. Admin UI

### 5.1 🔴 API base URL is hard-coded to `http://localhost:3003`
`admin-ui/app.js:17`. The UI is shipped as static files and the browser calls
this absolute URL, so the dashboard only works when the browser runs on the same
host that publishes admin-service on port 3003. There is no runtime
configuration mechanism (the `PORT` env var only affects the static file server,
not the baked-in client constant).

### 5.2 🔵 Front-end dependencies load from public CDNs at runtime
`admin-ui/index.html:14-15` imports VanJS from a `cdn.jsdelivr.net/gh/...`
GitHub path and htm from `unpkg.com`, with no Subresource Integrity. "Zero build
tools" is the stated design choice, but this means the UI breaks offline, has no
version pinning guarantees for the jsdelivr `gh/` path, and trusts third-party
CDNs at load time.

---

## 6. Build, reproducibility & ops hygiene

### 6.1 🟠 No lockfiles for the five JavaScript services
Only `config-service` has a `package-lock.json`. The other services' Dockerfiles
run `npm install` (not `npm ci`) with `^`-ranged dependencies, so image builds
are not reproducible and dev/CI/image versions can drift. (Several Dockerfiles
even comment "will generate package-lock.json", confirming none is committed.)

### 6.2 🔵 `/health` is liveness-only; DB readiness is never checked
Every service's `/health` returns `OK` without touching its datastore.
`checkHealth()` exists in `auth-service/db.js:79` and `url-service/db.js:66` but
is wired to **no route**. Compose healthchecks (and any future orchestrator) thus
treat a service with a dead database as healthy. A liveness/readiness split is
the standard remedy.

### 6.3 🔵 No graceful shutdown
No service handles `SIGTERM`. On restart/redeploy, in-flight requests are
dropped and pools aren't drained. Relevant to the monitoring/scaling curriculum.

### 6.4 🔵 Containers run as root
None of the Dockerfiles set a non-root `USER`. Fine for local dev; a deliberate
hardening exercise later.

### 6.5 🟠 Two compose files can drift
`compose.yml` (with healthchecks/ordering) and `compose-simple.yml` (without)
duplicate every service definition and will diverge over time.

### 6.6 🟠 CI covers only config-service
`.github/workflows/config-service.yml` is the only pipeline, and config-service
is the only service with any tests at all. The other five have neither tests nor
build/lint automation. (CI also pins `actions/setup-node@v3` / Node 20, while the
images use Node 24 — another version drift.)

### 6.7 🔵 No observability surface
No structured logging (everything is `console.log`/`console.error`), no
`/metrics` endpoint, no request IDs or cross-service tracing. Since monitoring is
an explicit teaching goal, this is a gap to fill intentionally rather than a
defect.

---

## 7. Documentation vs. reality

### 7.1 🟠 analytics-service is described but does not exist, and the description is self-contradictory
`README.md` and `architecture.mermaid` show an analytics-service. The README
table calls it **Java / MongoDB / ClickHouse** (`README.md:75`) while the
mermaid diagram labels it **Node.js** and shows it talking to ClickHouse. The
`compose.yml` analytics block is commented out (`compose.yml:163`), and there is
no `services/analytics-service/` directory. The intended direction (per planning)
is **Java + ClickHouse**; the docs need reconciling once it is built.

### 7.2 🟡 `config.schema.json` is unused
`config-service/config.schema.json` defines a JSON Schema for the config, but
nothing validates `config.json` against it at runtime or build time.

---

## 8. Design choices

### 8.1 Architectural choices to preserve
These are genuine and stay — they are part of what the project teaches:

- **Polyglot persistence** — PostgreSQL (auth), MySQL (url), ClickHouse (planned
  analytics). Teaches working with heterogeneous datastores.
- **Per-service data ownership** — no service reads another's database; data is
  only shared over HTTP APIs.

### 8.2 Intentional today — but planned for resolution, **not** left as-is
Per the maintainer, none of the following is a permanent "teaching hook" to be
left broken. Each is scheduled for a fix in PLANNING.md; the pedagogical value is
in students hitting the limitation and then resolving it, not in shipping it.

- **Centralized config-service, file-on-disk storage** — the centralization is
  fine, but the file store doesn't survive restarts and diverges across replicas
  (see §1, §6.2). → backed store, PLANNING **M5**.
- **admin-service as a pure aggregator** — keep the no-datastore pattern, but
  harden it: per-call timeouts (§4.3), response caching, and graceful degradation
  when a dependency is down. → PLANNING **M4**.
- **Zero-build admin UI (VanJS + htm)** — keep the no-bundler approach, but vendor
  the dependencies and make the API base runtime-configurable so it is neither
  CDN- nor host-dependent (§5.1, §5.2). → PLANNING **M6**.
- **The preserved "difficulties"** — per-instance redirect cache → shared cache
  (**M4**); file-based config → backed store (**M5**); plaintext `.env` secrets →
  secret injection (**M5**); no roles → role model (**M2**). All planned; none
  shipped by accident.

---

## Appendix — findings index

| # | Tag | Area | One-liner |
| --- | --- | --- | --- |
| 1.1 | 🔴 | config | Double `app.listen` → crash in prod image |
| 1.2 | 🔴 | config | Tests mutate `config.json` on disk |
| 2.1 | 🔵 | auth | Admin hard-coded to `user_id === 1`, duplicated x3 |
| 2.2 | 🔵 | auth | API keys stored in plaintext |
| 2.3 | 🔴 | auth | Key validation writes DB on every call |
| 2.4 | 🟠 | auth | `revoked_at` soft-delete vs hard `DELETE` |
| 2.5 | 🔴 | auth | Duplicate-email detection by error string |
| 2.6 | 🔵 | auth | Secrets committed in `.env` / hard-coded default |
| 2.7 | 🔵 | config | `PUT /config/domain` unauthenticated |
| 3.1 | 🔴 | url | Clicks counted on lookup; cache hides visits |
| 3.2 | 🟡 | url | `url_analytics` table never written |
| 3.3 | 🔵 | redirect | 301 permanent redirect breaks analytics |
| 4.1 | 🟠 | cross | Admin-check logic duplicated three ways |
| 4.2 | 🟠 | cross | snake_case vs camelCase across admin API |
| 4.3 | 🔴 | admin | `node-fetch` `timeout` option ignored |
| 4.4 | 🟡 | admin | `/admin/users/:id` 501; search filters in memory |
| 5.1 | 🔴 | admin-ui | API base hard-coded to `localhost:3003` |
| 5.2 | 🔵 | admin-ui | Front-end deps from public CDNs, no SRI |
| 6.1 | 🟠 | build | No lockfiles; `npm install` not `npm ci` |
| 6.2 | 🔵 | ops | `/health` liveness-only; DB readiness unchecked |
| 6.3 | 🔵 | ops | No graceful shutdown (SIGTERM) |
| 6.4 | 🔵 | ops | Containers run as root |
| 6.5 | 🟠 | ops | Two compose files can drift |
| 6.6 | 🟠 | ci | CI covers only config-service; Node 20 vs 24 |
| 6.7 | 🔵 | ops | No structured logging / metrics / tracing |
| 7.1 | 🟠 | docs | analytics-service described (Java vs Node?) but absent |
| 7.2 | 🟡 | config | `config.schema.json` unused |
