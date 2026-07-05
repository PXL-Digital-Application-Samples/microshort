# microshort — Project Review Report

> **Status update (2026-07-05):** all findings in this report (P0, P1, and P2) have been remediated in the codebase, including the ARCHITECTURE.md drift. Decisions taken while fixing: slug lookups now require a service token; the admin-ui JWT-refresh path was deleted (login is API-key only); milestone test files were renamed to descriptive names; register and API-key creation return 201. This report is kept as the review record — file/line references describe the pre-fix state.

**Date:** 2026-07-05
**Scope:** Architecture, assumptions, integrations, deployment readiness (AWS Academy Learner Lab → EC2-per-service via Terraform, and k3d/minikube-style Kubernetes), plus source code, repo organization, testing, code smells, DRY-ness, robustness, and UI.
**Method:** Full read of all service source, compose, CI, and docs; the stack was built and booted locally (all 11 containers healthy); the integration suite was executed (all **72 tests pass** on a fresh stack — see [Testing](#5-testing) for an instructive failure found along the way); deployment questions were checked against current online sources (listed at the end).

---

## Executive summary

microshort is an unusually well-executed teaching codebase. The architecture is coherent and honest about its tradeoffs (ARCHITECTURE.md is genuinely good), 12-factor config is applied consistently, every service has health/readiness/metrics endpoints, graceful shutdown, structured logging with request-ID propagation, Swagger docs, and CI that builds, tests, smoke-tests, and publishes images. Most "microservices theatre" mistakes are conspicuously absent.

**Verdict on deployment readiness:**

| Target | Ready? | Blockers |
|---|---|---|
| Local docker compose | ✅ Yes | None — verified working, 72/72 integration tests green |
| Single EC2 + compose | ✅ Yes, minor gaps | Restart policies, SG guidance |
| **One EC2 per service (Terraform, Learner Lab)** | ⚠️ Mostly | Env-var wiring supports it by design, but: admin-ui port-swap hack breaks, no restart policies, no SG/exposure guidance, analytics crash-loops without orchestration, Learner Lab 9-instance cap forces DB colocation |
| **HTTPS on AWS** | ⚠️ App is proxy-ready, but | The admin-ui `:3003→:3001` URL hack breaks under any TLS/ALB setup; nip.io/sslip.io (the obvious no-domain path) is **not reliable** for a whole class — see [§6.2](#62-https-on-aws--can-students-make-it-work) |
| k3d / minikube | ✅ Feasible | Images are on GHCR and probes exist (good); no manifests (by design); analytics crash-loop until ClickHouse is up is acceptable k8s behavior; local HTTPS via mkcert works |

**Top 5 things to fix before handing this to students** (full remediation plan in [§7](#7-remediation-plan)):

1. **`node_modules/` is committed to git** (774 files at the repo root, including Linux binaries) — committed before `.gitignore` took effect.
2. **Every Docker build disables TLS verification** (`npm config set strict-ssl false` in all six Node Dockerfiles, `-Dmaven.wagon.http.ssl.insecure=true` in the Maven build) — a corporate-proxy workaround that is a supply-chain risk and teaches exactly the wrong lesson.
3. **admin-ui breaks on any non-localhost deployment**: hardcoded `localhost` Swagger links, and a token-refresh path that rewrites `:3003` → `:3001` in the API URL and calls auth-service directly (violating the repo's own "UI only talks to admin-service" rule).
4. **Auth accepts anything as credentials** — `password: "x"`, `email: "not-an-email"` register successfully (verified live). Auth is a taught topic here; minimal validation is warranted.
5. **Known default tokens fall back silently** — compose uses `${ADMIN_SERVICE_TOKEN:-dev-admin-token}` etc.; a student who omits these from `.env` deploys to public EC2s with guessable service tokens.

---

## 1. Architecture & assumptions

### What is right

- **Genuine service isolation.** No shared code, no shared DB, HTTP-only contracts. Verified: no service imports another's modules; no cross-database queries.
- **The dependency graph in ARCHITECTURE.md matches compose** (`depends_on` + healthchecks enforce DB → auth/config → url → redirect/admin ordering).
- **Deliberate, documented tradeoffs** — at-most-once analytics, 302-vs-301 reasoning, CQRS click counts, IP hashing before egress. These are the right lessons.
- **12-factor discipline is real, not aspirational** — every inter-service URL is an env var with a Docker-DNS default (`envalid`-validated). This is precisely what makes the EC2-per-service exercise possible without code changes.
- **Polyglot on purpose** works: the Java service follows the same conventions (request-ID filter, token filter, probes) as the Node ones.

### Assumption gaps (matter for your deployment plans)

| # | Finding | Impact |
|---|---|---|
| A1 | **Compose publishes every port to the host** (3000–3005, 8080, 6379, 8123). Fine locally, but students will replicate this pattern in EC2 security groups. Nothing documents which ports are *public* (8080, 3004, maybe 3003) vs. *internal only* (everything else, especially Redis 6379 and ClickHouse 8123). | High — a class of students will put MySQL/Redis/ClickHouse on the public internet |
| A2 | **`GET /urls/:slug` on url-service is unauthenticated** ([index.js:418](services/url-service/src/index.js:418)). Deliberate (redirect-service calls it without a token), but combined with A1 it means anyone can enumerate slug→URL mappings on port 3002. Either require a service token from redirect-service, or document loudly that 3002 must never be public. | High in per-service EC2 setup |
| A3 | **Startup ordering only exists inside compose.** On separate EC2s / k8s there is no `depends_on`. Node services handle this well (lazy DB pools, `lazyConnect` Redis). analytics-service will **crash at boot if ClickHouse is unreachable** (HikariCP fail-fast) — fine under k8s restart semantics, fatal on a bare EC2 without a restart policy. | Medium |
| A4 | **No `restart:` policy on any service except redis.** On EC2, a crashed container (or instance reboot — Learner Lab *stops all instances when the session ends*) stays dead. Add `restart: unless-stopped` across the board. | High for EC2 |
| A5 | **`X-Forwarded-For` trust is hardcoded** (`app.set('trust proxy', 1)`). Correct behind exactly one proxy (ALB), wrong for direct exposure (IP spoofing of rate limits) and wrong behind two hops (CloudFront → ALB). Make it an env var. | Medium |
| A6 | `.env.example` marks `SERVICE_TOKEN` as *deprecated* in favor of per-service tokens, yet compose makes `SERVICE_TOKEN` required (`:?`) and the per-service tokens optional with defaults. Backwards — invert it. | Medium |

### Documentation drift (ARCHITECTURE.md vs. reality)

Verified against the running stack:

- **Redis namespaces are wrong**: doc says `url:<slug>`, `rl:<ip>:auth`, `rl:<ip>:url`; actual keys are `slug:<slug>`, `rl-auth:<ip>`, `rl-validate:<ip>`, `rl-url:<ip>`, `rl-redirect:<ip>` (live-verified with `redis-cli keys`). Also the doc omits the validate/redirect limiters entirely.
- **`GET /actuator/prometheus` does not exist**: doc promises it, but [application.properties:12](services/analytics-service/src/main/resources/application.properties:12) only exposes `health,info`, and the `ServiceTokenFilter` returns **401** for it anyway (live-verified). The `micrometer-registry-prometheus` dependency is in the pom, so this is a two-line fix.
- **"All API calls from the browser go through admin-service only"** — false; the token-refresh path in [app.js:49](services/admin-ui/public/app.js:49) calls auth-service directly.
- The M11/M12 milestone naming in tests has no key anywhere in the docs; nobody new to the repo can tell what "M7" covers.

---

## 2. Integrations (service-to-service)

Reviewed each cross-service call path. Overall: consistent timeout discipline (`AbortSignal.timeout` on every fetch — genuinely rare and commendable), request-ID propagation everywhere, and graceful degradation in admin-service (`fetchUpstream` returns null + `degraded[]` in the dashboard payload — nice pattern).

Findings:

| # | Finding | Where |
|---|---|---|
| I1 | **redirect-service event buffer is unbounded.** If analytics is down while traffic flows, `eventBuffer` grows forever (failed batches are `unshift`ed back, new events keep appending). Memory-exhaustion under sustained outage. Cap it (e.g. drop oldest beyond 10k) and count drops in a metric — that's also a better lesson. | [index.js:153-192](services/redirect-service/src/index.js:153) |
| I2 | **`getDomain()` discards its stale cache on failure.** If config-service is briefly down and the 60s cache just expired, URL creation 500s even though the last-known domain is sitting in the variable. Serve-stale-on-error is the standard fix (and a good teaching moment). | [index.js:125-147](services/url-service/src/index.js:125) |
| I3 | **Authorization inconsistency:** `PUT /urls/:slug` lets an admin update anyone's URL (`req.user.role !== 'admin'` check); `DELETE /urls/:slug` has no admin override — an admin gets 403 deleting another user's URL. One of the two is wrong. | [index.js:531-555 vs 606-648](services/url-service/src/index.js:606) |
| I4 | **Service-token bypass fabricates user `{ id: 0, role: 'admin' }`** in url-service middleware. Works, but the magic id 0 is implicit and `validateApiKey` vs `requireAdminApiKey` are ~80% copy-paste of each other in the same file — the clearest genuine DRY violation in the repo (the *cross*-service duplication is a stated design choice; *intra*-service duplication is not). | [index.js:150-228](services/url-service/src/index.js:150) |
| I5 | Auto-generated slug collision (nanoid(6)) returns **409 to the user** instead of retrying generation. At ~1M URLs the birthday-collision odds get real. Retry loop of 3 is enough. | [index.js:349-373](services/url-service/src/index.js:349) |
| I6 | admin-service dashboard caches **degraded** responses for the full 10s TTL — a one-blip outage shows as degraded for 10 extra seconds. Skip caching when `degraded.length > 0`. | [index.js:233-291](services/admin-service/src/index.js:233) |
| I7 | admin-service `GET /admin/urls` proxies without forwarding pagination query params (`cursor`/`limit` accepted by url-service but dropped by the proxy) — the UI can only ever see the first 50 URLs. | [index.js:378-398](services/admin-service/src/index.js:378) |

---

## 3. Source code quality

### Cross-cutting (Node services)

**Good:** consistent structure (`index.js` / `db.js` / `env.js` / `utils.js`), parameterized SQL everywhere (no injection found, including the ClickHouse repository), SHA-256-hashed API keys with show-once semantics, timing-safe token comparison (the digest-then-compare trick correctly handles length differences), graceful shutdown with force-exit timers, fire-and-forget `last_used_at`, first-user-becomes-admin done properly with a table lock.

**Smells / issues:**

| # | Finding | Severity |
|---|---|---|
| C1 | **~120 lines of identical boilerplate per service** (prometheus counters + histogram, pino-http setup, X-Request-ID middleware, metrics middleware, `safeTokenEqual`, swagger scaffold) copy-pasted across 5 services. The no-shared-library rule is a stated design principle, and for a teaching repo that's defensible — but then the boilerplate should be *minimal*. Consider at least noting in ARCHITECTURE.md that this duplication is the accepted cost of the rule, or trim the per-service metrics middleware to a few lines. | Low (by design) but worth an explicit note |
| C2 | **Numeric env vars typed as `str` + scattered `parseInt`** (`PORT`, `LOGIN_RATE_LIMIT_MAX`, `CLICK_SYNC_INTERVAL_MS`, …). envalid has `num()` and `port()` — using them removes every `parseInt` call site and validates at boot. | Low |
| C3 | **No password or email validation on register** — `"x"` / `"not-an-email"` accepted (verified live). Swagger even documents `minLength: 1`. | High (teaching credibility) |
| C4 | Register/login return **200**, Swagger says 200, REST convention says **201** for register. Minor, but students copy what they see. | Low |
| C5 | Refresh tokens are stateless with no rotation/revocation (logout can't invalidate). Acceptable for teaching, but worth one sentence in ARCHITECTURE.md's auth section since revocation *is* implemented for API keys. | Low |
| C6 | `searchUrls` builds a quoted boolean-mode phrase by stripping operators — correct-ish, but the double effort (LIKE prefix + FULLTEXT) with silently different semantics deserves a comment; short tokens below `innodb_ft_min_token_size` return nothing. | Low |
| C7 | CORS defaults to `*` on auth/url/admin services; `.env.example` has `ALLOWED_ORIGINS` commented out. Fine locally; must be set in any HTTPS deployment or the browser admin-ui will be the only thing that *works* while every drive-by site can also call the API. | Medium |
| C8 | config-service `getValidateConfig()` recompiles the Ajv schema on every PUT — trivial load, but Ajv compile-per-request is the canonical Ajv anti-pattern; compile once per NODE_ENV. | Low |
| C9 | config-service Dockerfile runs `npx vitest run` **inside the image build** — tests in builds are non-hermetic and slow rebuilds; CI already runs them. | Low |

### analytics-service (Java)

Solid: constructor injection, records for the event model, JDBC batch insert, `MessageDigest.isEqual` for tokens, MDC-based correlation IDs, multi-token allow-list (supports both legacy and per-service tokens simultaneously — good migration pattern).

- **J1:** `/actuator/prometheus` missing/blocked (see doc drift above). Fix: add `prometheus` to `management.endpoints.web.exposure.include` and exempt `/actuator/prometheus` in `ServiceTokenFilter` (or document that the scraper must send the token).
- **J2:** `ServiceTokenFilter` default tokens (`dev-service-token-change-in-production`) mirror the compose-default problem (see T3 below).
- **J3:** No `Instant` parsing guard on `ClickEvent.ts` — a malformed timestamp fails Jackson deserialization with a raw 400/500; acceptable, but a `@ControllerAdvice` returning a clean error would match the Node services' style.
- **J4:** `getSlugStats` passes `from`/`to` strings straight into `ts BETWEEN ? AND ?` (DateTime column) — works via CH implicit cast but will confusingly return empty for date-only strings vs. the `clicks_daily` query. Minor.

### Secrets & tokens

| # | Finding | Severity |
|---|---|---|
| T1 | **`strict-ssl false` / Maven `ssl.insecure=true` in every Dockerfile.** The TODO comments admit it's a corporate-proxy workaround. On student machines (no corp proxy) it's pure downside: package-registry MITM exposure and normalization of disabling TLS. Remove; if the build machine needs a corp CA, follow the TODO properly. | **High** |
| T2 | `.env.example` uses `change-me-in-production` for all eight secrets, and the stack works with them as-is. Good for onboarding — but there is no guard preventing those values in a "production" mode. Cheap win: config-service already has a `NODE_ENV=production` https check; add an equivalent "secrets must not contain `change-me`" check in each `env.js` when `NODE_ENV=production`. | Medium |
| T3 | **Compose falls back to known dev tokens** (`${ADMIN_SERVICE_TOKEN:-dev-admin-token}`, `-dev-url-token`, `-dev-redirect-token`) instead of `:?`-enforcing them like the other secrets, and analytics-service repeats defaults in application.properties. A student who copies an older `.env` missing the three newer vars gets a *working* stack with publicly guessable internal tokens. Make all three required. | **High** |
| T4 | Redis has **no password** and is port-published (6379). Local: fine. Any shared/cloud network: cache poisoning of `slug:<slug>` = open-redirect factory. Needs a loud warning + SG guidance (or `requirepass`). | High on EC2 |

---

## 4. Repo organization

- **R1 (High):** **`node_modules/` is tracked in git** — 774 files at the root, including `@esbuild/linux-x64` and `rollup-linux-x64-gnu` native binaries and a `.vite` results cache. It predates the `.gitignore` entry (ignore rules don't untrack). Fix: `git rm -r --cached node_modules` + commit. This is the single most embarrassing thing students will notice.
- **R2:** Test files named by milestone (`m2/`, `m3/`, `m4.integration.test.js` … `m12`) with no legend. Rename to what they test (`observability.test.js`, `service-tokens.test.js`, …) or add a mapping table to the README.
- **R3:** `test-ui.sh` (grep-based VanJS lint) is Bash-only, not in CI, and not mentioned in any README. Wire it into the services workflow or delete it.
- **R4:** `AGENTS.md`/`GEMINI.md` pointer files are a pragmatic touch. Fine.
- **R5:** Per-service READMEs + `example.http` files exist for all services — genuinely good. LICENSE present.
- **R6:** CI images are pushed to GHCR **only as `:latest`**. For the k8s exercise students can't pin or roll back. Tag with the git SHA as well (`:latest` + `:${{ github.sha }}`) — also a better DevOps lesson.
- **R7:** [integration-rate-limit.yml](.github/workflows/integration-rate-limit.yml) PR path filter watches `tests/integration/rate-limit/**` — a directory that doesn't exist (the file is `tests/integration/m2/rate-limiting.test.js`). PRs touching only that test won't trigger the workflow.

---

## 5. Testing

**State:** 72 integration tests across 11 files (all pass, verified on a fresh stack), unit tests in 4 services + Java tests in the Maven build, CI running unit + docker smoke + full-stack integration + a separate rate-limit e2e profile with a compose override. For a teaching repo this is far above average. The compose-override trick for shrinking rate-limit windows is elegant.

**Instructive finding from this review:** the first local run failed 26/72 tests with cascading 429s. Root cause: stale DB volumes from an earlier run (different password) made the *MySQL* step of `resetDb()` throw — and because [helpers.js:13-22](tests/integration/helpers.js:13) wraps psql → mysql → redis in **one** try/catch that only `console.error`s, the Redis `FLUSHALL` (which resets rate-limit counters) silently never ran. The suite then died of its own rate limiter with an error message pointing nowhere near the cause. Your students **will** hit exactly this (password changes + persistent volumes is a classic Docker gotcha, and it's even noted in the schema files).

| # | Finding | Fix |
|---|---|---|
| TE1 | `resetDb()` swallows failures and aborts remaining steps | Run each step in its own try/catch; `throw` at the end if any failed so vitest reports "DB reset failed — did you change passwords without `docker compose down -v`?" |
| TE2 | The suite implicitly depends on `FLUSHALL` to stay under the auth rate limit (10 registrations / 15 min) | Either raise `LOGIN_RATE_LIMIT_MAX` in a test override (like the rate-limit profile does in reverse), or keep TE1's loud failure |
| TE3 | `BASE` URLs hardcoded to `localhost` in [helpers.js:3-11](tests/integration/helpers.js:3) | Read from env (`BASE_URL_AUTH ?? localhost:3001`) — then the same suite doubles as a smoke test students can point at their AWS/k3d deployment. High-leverage change for your course. |
| TE4 | Fallback literals in helpers drift from `.env.example` (`urlpass`, `dev-service-token-change-in-production`) — they only work because `.env` is loaded | Align or remove the fallbacks |
| TE5 | admin-ui has no unit tests (`has_tests: false` in CI) and the m6 integration test checks config injection, not rendering | Acceptable; `test-ui.sh` partially covers it — wire it into CI (R3) |
| TE6 | Unit-test coverage is thin but well-chosen (pure functions: hashing, slug/key format, ip-hash, buffer). The heavy logic (route handlers) is only covered end-to-end. For teaching, fine. | — |

---

## 6. Deployment readiness

### 6.1 One EC2 per service (Terraform, AWS Academy Learner Lab)

**The app is architecturally ready for this** — every peer URL is an env var, nothing assumes Docker DNS except the *defaults*. What's missing is operational glue:

1. **Learner Lab instance cap: max 9 concurrent instances, max 32 vCPU, instance types up to `large`, us-east-1/us-west-2 only.** The stack has 7 services + 4 datastores = 11 components. Plan: **colocate each datastore with its owning service** (auth+postgres, url+mysql, analytics+clickhouse, redirect+redis) → 7 instances. This colocation is also the honest reading of "each service owns its datastore."
2. **Learner Lab sessions stop all instances**; public IPv4 addresses change on every stop/start. Two consequences:
   - **Inter-service wiring must use private IPs** (private IPs *persist* across stop/start within the VPC) or Route 53 private hosted zone records — never public IPs. This is worth teaching explicitly.
   - Public entry points (redirect :8080/:443, admin-ui, admin-service) should get **Elastic IPs** (default quota 5/region — enough for the 3 public-facing ones).
3. **No restart policies** (A4) — on EC2, add `restart: unless-stopped` (or systemd units) or every session-stop leaves dead containers. analytics-service especially: it fail-fasts if ClickHouse isn't up yet (A3), so it needs restart-with-backoff or an ordered boot.
4. **Security-group guidance is absent** (A1/A2/T4). Minimum doc: public = 8080/443 (redirect), 3004 (admin-ui), 3003 (admin-service, needed by the browser); everything else (3000-3002, 3005, 5432, 3306, 6379, 8123) internal-SG only.
5. Per-service tokens with dev defaults (T3) become real vulnerabilities here.
6. Sizing: ClickHouse + JVM on one box wants `t3.large` (Learner Lab's ceiling); the Node services run fine on `t3.micro/small`. Budget note: 7 instances × class hours fits the $50–100 Learner Lab credit if students stop labs, which Learner Lab enforces anyway.
7. Nothing in the repo needs to change for Terraform itself (by design, deployment tooling lives elsewhere) — but consider shipping a `compose.single-service.yml` example or documented `docker run` line per service, since students will otherwise copy the full compose file to every instance and start 11 containers on each.

**Verdict: deployable with ~1 day of repo polish (restart policies, token enforcement, SG/exposure doc, private-IP guidance).**

### 6.2 HTTPS on AWS — can students make it work?

**The application is correctly TLS-agnostic**: no service terminates TLS (right answer — terminate at a proxy/LB), `trust proxy` is set, `DOMAIN` accepts https URLs, config-service even *enforces* `https://` on domain updates when `NODE_ENV=production`, and admin-ui's CSP `connect-src` follows `ADMIN_API_URL`. Cookies aren't used, so no Secure-flag issues.

**One real blocker:** the admin-ui token-refresh hack ([app.js:49](services/admin-ui/public/app.js:49)) rewrites `:3003` → `:3001` in the API base URL to reach auth-service directly. Behind HTTPS/ALB there is no `:3003` in the URL, so this breaks — and it also violates the stated architecture. The whole refresh path looks vestigial (login is API-key-based, not JWT-based); **delete it**, or route refresh through admin-service. Same for the hardcoded `http://localhost:{3000..3005}/docs` links in [Health.js:1-7](services/admin-ui/public/components/Health.js:1).

**Scenario A — student owns a domain** (e.g. via GitHub Student Developer Pack, which includes a free Namecheap `.me`): the full first-class AWS flow works in Learner Lab:
- Route 53 **hosted zone** (allowed; domain *registration* through Route 53 is not — register externally and point NS records),
- ACM public certificate with DNS validation,
- **ALB** with the ACM cert → target group → redirect-service :8080 (+ a second listener rule or ALB for admin-ui/admin-service).
- Alternatively, skip ALB cost: Caddy or nginx+certbot on the redirect EC2 does Let's Encrypt HTTP-01 in one config line. Cheaper, and arguably teaches more.

**Scenario B — no domain**: this is where the common advice fails:
- **nip.io / sslip.io + Let's Encrypt is NOT dependable for a class.** Rate limits are counted against nip.io/sslip.io as a whole (they're not on the Public Suffix List), and the shared quota is chronically exhausted ([sslip.io issue #108](https://github.com/cunnie/sslip.io/issues/108)). One student may succeed; thirty in the same week will not.
- **Recommended: DuckDNS (or similar free dynamic-DNS on the Public Suffix List)** — each student claims `student-x.duckdns.org`; because duckdns.org is on the PSL, Let's Encrypt rate limits apply per subdomain. Caddy has a DuckDNS DNS-01 plugin; certbot works too. Free, reliable, real certs.
- **Alternative: CloudFront with the default `*.cloudfront.net` certificate** — real browser-trusted HTTPS, zero domains, and CloudFront is available in Learner Lab. Caveats: origin must be a DNS name (use the EC2 public DNS name, which changes each session-stop → pair with an Elastic IP's static DNS name), and caching must be disabled for the redirect path (or you re-create the 301-analytics-loss problem ARCHITECTURE.md warns about — actually a great exam question).
- **Fallback: Caddy's internal CA / mkcert self-signed** — teaches the TLS mechanics with a browser warning. Fine as a stepping stone, not as the end state.

**Answer: yes, students can make HTTPS work in Learner Lab in both scenarios — but only if the course steers them to ALB+ACM or Caddy (domain case) and DuckDNS or CloudFront (no-domain case), and the admin-ui port hack is removed first.**

### 6.3 k3d / minikube

Feasible today, with the right expectations:

- **Images:** CI already publishes all services to GHCR (`ghcr.io/pxl-digital-application-samples/microshort-*`) — students can deploy without building in-cluster. Verify the packages are public, and add SHA tags (R6).
- **Probes:** `/health` + `/ready` (and Spring Actuator's liveness/readiness) map 1:1 to k8s probes — the repo is genuinely well-prepared here.
- **Ordering:** no `depends_on` in k8s; Node services tolerate absent dependencies (lazy pools — verified in code), analytics-service will CrashLoopBackOff until ClickHouse is ready, which is *normal, correct* k8s behavior worth teaching rather than hiding (initContainers as the follow-up lesson).
- **Datastores:** official postgres/mysql/clickhouse/redis images + the existing `init/*.sql` mounted from ConfigMaps reproduce the compose bootstrap exactly.
- **Networking:** k3d ships Traefik and can map host 80/443 to the ingress at cluster-create time (`-p "80:80@loadbalancer" -p "443:443@loadbalancer"`); minikube uses the ingress addon + tunnel. The env-var URL wiring maps directly to k8s Service DNS names (`http://url-service:3002` works verbatim if Services are named accordingly — the compose defaults literally are valid k8s DNS).
- **Local HTTPS:** **mkcert** is the clean path — generate a locally-trusted wildcard cert, store as a TLS secret, reference from the Ingress. Browser-green HTTPS offline. cert-manager + Let's Encrypt does *not* work for localhost (no public reachability); Traefik's default self-signed cert works with warnings. mkcert is the teachable middle.
- **admin-ui runtime config shines here**: `ADMIN_API_URL` env var + `/config.js` injection was built for exactly this. The port-swap hack (again) is the only thing that breaks.

**Answer: yes — k3d/minikube deployment and local HTTPS (mkcert + Traefik/ingress) are realistic student exercises against this repo as-is, no code changes strictly required except the admin-ui fixes.**

---

## 7. Remediation plan

### P0 — before handing to students (≈1 day)

| | Action | Ref |
|---|---|---|
| 1 | `git rm -r --cached node_modules` and commit | R1 |
| 2 | Remove `strict-ssl false` from all 6 Node Dockerfiles and `ssl.insecure` flags from the analytics Dockerfile | T1 |
| 3 | Make `ADMIN_SERVICE_TOKEN`, `URL_SERVICE_TOKEN`, `REDIRECT_SERVICE_TOKEN` required (`:?`) in compose; remove defaults from `application.properties` | T3 |
| 4 | Delete (or route through admin-service) the admin-ui JWT-refresh path and its `:3003→:3001` rewrite; make Swagger links in Health.js relative or config-driven | §6.2 |
| 5 | Add `restart: unless-stopped` to all services in compose | A4 |
| 6 | Add minimal register validation (email format, password ≥ 8) | C3 |
| 7 | Fix `resetDb()` to run steps independently and fail loudly | TE1 |
| 8 | Add a "Deployment exposure" section to ARCHITECTURE.md: public ports vs. internal, Redis/ClickHouse must never be public, private-IP wiring on EC2 | A1/A2/T4 |

### P1 — high-value polish (≈1–2 days)

| | Action | Ref |
|---|---|---|
| 9 | Cap the redirect-service event buffer + drop metric | I1 |
| 10 | Expose `/actuator/prometheus` and exempt it (or document the token) — fixes the doc promise | J1 |
| 11 | Fix ARCHITECTURE.md drift: Redis namespaces, admin-ui/auth-service claim, milestone-test legend | §1 |
| 12 | Parametrize integration-test `BASE` URLs via env — reuse the suite as a post-deploy smoke test on AWS/k3d | TE3 |
| 13 | Serve-stale on `getDomain()` failure; don't cache degraded dashboards | I2, I6 |
| 14 | Reconcile PUT/DELETE admin-override inconsistency in url-service; dedupe `validateApiKey`/`requireAdminApiKey` | I3, I4 |
| 15 | Fail startup on `change-me` secrets when `NODE_ENV=production` | T2 |
| 16 | Tag GHCR images with git SHA; fix the rate-limit workflow path filter | R6, R7 |
| 17 | Fix the VanJS Health-view interval leak (derive() has no cleanup semantics; track the interval at app level or clear before re-create) | [Health.js:29-47](services/admin-ui/public/components/Health.js:29) |

### P2 — nice-to-have

Retry auto-slug on collision (I5); forward pagination in the admin proxy (I7); envalid `num()`/`port()` types (C2); 201 on register (C4); `trust proxy` via env (A5); Ajv compile-once (C8); drop in-build tests from the config-service Dockerfile (C9); ALLOWED_ORIGINS documentation for HTTPS deployments (C7); wire `test-ui.sh` into CI or remove (R3); rename milestone tests (R2); Redis `requirepass` option (T4); `compose.single-service.yml` example for the per-EC2 exercise (§6.1.7).

---

## 8. What was verified live

- `docker compose up -d --build --wait`: all 11 containers healthy.
- Full integration suite: **72/72 pass** on fresh volumes; the stale-volume failure mode (26 failures via silent `resetDb` abort → rate-limiter cascade) was reproduced and root-caused (TE1).
- `/actuator/prometheus` → 401 (J1 confirmed).
- `POST /auth/register` with `{"email":"not-an-email","password":"x"}` → 200 + token (C3 confirmed).
- Redis keyspace: `slug:*`, `rl-auth:*`, `rl-validate:*`, `rl-url:*`, `rl-redirect:*` (doc drift confirmed).
- Unauthenticated `GET :3002/urls/:slug` reachable from the host (A2 confirmed).

## Sources

- [sslip.io / nip.io](https://sslip.io/) and [Let's Encrypt rate-limit exhaustion for sslip.io (issue #108)](https://github.com/cunnie/sslip.io/issues/108)
- [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)
- [AWS Academy Learner Lab educator guide](https://d1.awsstatic.com/AWS%20Academy%20Learner%20Lab%20Educator%20Guide.pdf) and [Learner Lab foundation services list](https://cyberlab.pacific.edu/courses/comp175/resources/aws-academy/AWS_Academy_Learner_Lab-Foundational_Services.pdf) (regions us-east-1/us-west-2, 9-instance / 32-vCPU caps, instance types ≤ large)
- [ACME support in AWS Certificate Manager](https://aws.amazon.com/blogs/aws/automate-public-tls-certificate-issuance-with-acme-support-in-aws-certificate-manager/)
- [HTTPS on Kubernetes with Traefik](https://traefik.io/blog/https-on-kubernetes-using-traefik-proxy), [k3d ingress setup](https://github.com/scaamanho/k3d-cluster/blob/master/Ingress-Controller.md), [cert-manager + Let's Encrypt on k3s](https://k3s.rocks/https-cert-manager-letsencrypt/)
- [Caddy + Docker automatic HTTPS](https://oneuptime.com/blog/post/2026-02-08-how-to-run-caddy-with-docker-and-automatic-https-wildcard-certificates/view)
