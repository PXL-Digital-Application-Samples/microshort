# IMPLEMENTATION PLAN — M5: Configuration & Secrets

> **Status**: Ready to implement  
> **Prerequisite**: M4 complete (Redis shared cache, structured logging, Prometheus metrics, readiness endpoints, graceful SIGTERM — all services healthy)  
> **Source of truth for scope**: PLANNING.md §5; CODE_REVIEW.md CR 2.6, CR 7.2, CR §8.2

---

## 0. Scope, Findings, and Locked Decisions

### 0.1 What M5 fixes

| Finding | Description | Workstream |
|---------|-------------|------------|
| CR 2.6  | `JWT_SECRET`, DB passwords, service tokens committed in `.env` with working defaults | C, D |
| CR 7.2  | `config.schema.json` exists but nothing validates against it at load or PUT | A |
| CR §8.2 | config-service file-on-disk store doesn't survive restarts and diverges across replicas | A |

### 0.2 Locked design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config source | **`DOMAIN` env var** (12-factor) | File-on-disk doesn't survive stateless containers or horizontal scale; env vars are deployment-native, consistent across replicas, and satisfy every separately-taught deployment model (Ansible, Swarm, K8s) without code changes |
| PUT /config/domain | **Keep, explicitly ephemeral** | Useful for runtime admin ops and testing; ephemerality is the lesson: changes reset on restart unless baked into the deployment env |
| Startup secrets validation | **envalid** (per-service) | Validates `process.env` directly — no example file needed at runtime, no Docker-image coupling, TypeScript-native, calls `process.exit(1)` with a clear message on failure |
| Schema validation library | **Ajv v8 + ajv-formats** | The existing `config.schema.json` uses `format: "uri"` which requires ajv-formats; Ajv v8 ships TypeScript types |
| Compose secret enforcement | **`:?` form for true secrets** | `${JWT_SECRET:?...}` causes `docker compose up` to fail loudly when `.env` is missing — the compose-layer fail-fast paired with per-service envalid validation covers both Docker and direct-run paths |
| JSON schema import | **resolveJsonModule + plain import** | `import schema from '../config.schema.json'` with `"resolveJsonModule": true` in tsconfig; no `assert { type: 'json' }` (fragile in CommonJS module settings) |

### 0.3 PLANNING.md note

PLANNING.md §5 M5 currently reads "Do not replace config-service's file-on-disk store … Students may first observe the file-store limitation, and need to fix this themselves." The maintainer's decision (2026-06-09) supersedes this phrasing: **env-var config is the fix**. PLANNING.md §5 will be updated to reflect this as part of Workstream G.

### 0.4 True secrets vs. service config

Two distinct categories of environment variable:

| Category | Variables | Compose form | Behaviour if missing |
|----------|-----------|--------------|----------------------|
| **True secrets** | `JWT_SECRET`, `AUTH_DB_PASSWORD`, `URL_DB_PASSWORD`, `URL_DB_ROOT_PASSWORD`, `SERVICE_TOKEN`, `IP_HASH_SALT`, `CLICKHOUSE_PASSWORD`, `CONFIG_WRITE_TOKEN`, `DOMAIN` | `${VAR:?error message}` | compose exits; service exits via envalid |
| **Service config** | `PORT`, `LOG_LEVEL`, `REDIS_URL`, `*_SERVICE_URL`, `CLICK_SYNC_INTERVAL_MS` | `${VAR:-default}` kept | Sensible default applies |

`DOMAIN` is classified as a secret because it controls the publicly-visible URL space for all short links — changing it incorrectly breaks every existing short URL.

---

## 1. Current-State Facts

### 1.1 config-service

- `server.ts` lines 92–110: `loadConfig()` reads `../config.json` from disk
- `server.ts` lines 112–116: `saveConfig()` writes to `../config.json`
- `server.ts` lines 118–126: `getConfig()` caches with 60 s TTL
- `Dockerfile` final stage: `COPY config.json ./config.json` — bakes file into image
- `config.json` contains `{ "domain": "http://localhost:8080" }`
- `config.schema.json` exists, defines `domain` as `type: string, format: uri` — **never referenced in code**
- `tsconfig.json` does **not** have `"resolveJsonModule": true`
- `PUT /config/domain` already validates `CONFIG_WRITE_TOKEN` header (CR 2.7 resolved in M4)
- `/ready` currently calls `loadConfig()` — will need updating when file store is removed

### 1.2 .env and secret hygiene

- `.env` file in repo root: tracked by git (confirmed via `git ls-files`)
- Contains working default values: `JWT_SECRET=dev-secret-change-in-production`, `AUTH_DB_PASSWORD=authpass`, etc.
- No `.gitignore` exists in the repo root
- `compose.yml` uses `${VAR:-default}` for all secrets — defaults always succeed
- No per-service startup validation; missing secrets go undetected until runtime failure

### 1.3 All Node services

- No `envalid` or startup env-var validation anywhere
- No per-service `.env.example` files

### 1.4 analytics-service (Java)

- Uses `@Value("${SERVICE_TOKEN}")` in `AnalyticsController` for `X-Service-Token` validation
- `CLICKHOUSE_PASSWORD` is read by Spring JDBC config
- Spring Boot auto-fails on undefined `@Value` properties — analytics already has Java-native fail-fast behavior; **no new Java code needed**

---

## 2. Workstreams

---

### Workstream A — config-service: env-var driven config + Ajv validation

**Files affected:**
- `services/config-service/tsconfig.json`
- `services/config-service/package.json`
- `services/config-service/src/server.ts`
- `services/config-service/Dockerfile`
- `services/config-service/config.json` — **deleted**

#### A.1 Add `resolveJsonModule` to tsconfig

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

#### A.2 Install Ajv

```bash
cd services/config-service
npm install ajv ajv-formats
```

Add `"ajv": "^8.0.0"` and `"ajv-formats": "^3.0.0"` to `package.json` `dependencies`.

#### A.3 Refactor `server.ts` — replace file-based config with env-var config

Remove all file I/O from the config layer. Replace `loadConfig`, `saveConfig`, `getConfig`, and the `cachedConfig`/`cacheTimestamp` variables with a simple in-memory state seeded from the `DOMAIN` env var.

**Add imports at the top of `server.ts`:**

```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import configSchema from '../config.schema.json';
```

**Add validation setup after imports, before `const app = express()`:**

```typescript
const ajv = new Ajv();
addFormats(ajv);
const validateConfig = ajv.compile(configSchema);

const rawDomain = process.env.DOMAIN;
if (!rawDomain) {
  console.error('FATAL: DOMAIN environment variable is required but not set.');
  process.exit(1);
}
if (!validateConfig({ domain: rawDomain })) {
  console.error('FATAL: DOMAIN is not a valid URI:', validateConfig.errors);
  process.exit(1);
}

// In-memory config state. Seeded from env var at startup.
// PUT /config/domain mutates this at runtime (ephemeral — resets on restart).
let currentDomain = rawDomain;
```

**Replace `loadConfig` / `saveConfig` / `getConfig` with:**

```typescript
// No loadConfig / saveConfig / getConfig — config comes from env var.
// currentDomain is the single in-memory source of truth.
```

**Rewrite `GET /config/domain`:**

```typescript
app.get('/config/domain', (req: Request, res: Response): void => {
  res.json({ domain: currentDomain });
});
```

**Rewrite `PUT /config/domain`:**

```typescript
app.put('/config/domain', (req: Request, res: Response): void => {
  const expected = process.env.CONFIG_WRITE_TOKEN;
  if (!expected || req.headers['x-service-token'] !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { domain } = req.body;
  if (!validateConfig({ domain })) {
    res.status(400).json({ error: 'Validation failed', details: validateConfig.errors });
    return;
  }

  currentDomain = domain;
  (req as any).log.warn(
    { domain, note: 'ephemeral — will reset to DOMAIN env var on restart' },
    'Domain updated in-memory'
  );
  res.json({
    message: 'Domain updated',
    domain,
    warning: 'This change is ephemeral. Set DOMAIN env var to persist across restarts.'
  });
});
```

**Rewrite `/ready`:**

```typescript
app.get('/ready', (_req: Request, res: Response): void => {
  // If the service started, DOMAIN was already validated — always ready.
  res.json({ status: 'ready', domain: currentDomain });
});
```

Remove the `try/catch` around `loadConfig()` that was previously in `/ready` — it's no longer needed.

Also **remove all `import fs from 'fs/promises'`** and `import path from 'path'` references if they were only used for file I/O (check for other usages first — `configPath()` and the swagger `__dirname` resolution may still need `path`).

#### A.4 Update Dockerfile — remove `config.json` copy

In `services/config-service/Dockerfile`, in the final stage, remove:
```
COPY config.json ./config.json
```

`config.schema.json` does NOT need to be copied separately — with `resolveJsonModule: true`, TypeScript inlines the JSON into the compiled `dist/server.js` at build time.

#### A.5 Delete `config.json`

```bash
rm services/config-service/config.json
git rm services/config-service/config.json
```

`config.schema.json` stays — it is the canonical spec.

**Verify steps:**
1. `cd services/config-service && DOMAIN=http://localhost:8080 npm run dev` → service starts, logs valid domain
2. `DOMAIN=not-a-uri npm run dev` → exits with `FATAL: DOMAIN is not a valid URI`
3. No `DOMAIN` set → exits with `FATAL: DOMAIN environment variable is required`
4. `curl http://localhost:3000/config/domain` → `{"domain":"http://localhost:8080"}`
5. `curl -X PUT ... -d '{"domain":"http://example.com"}'` → `200` with `warning` field
6. Restart service → `GET /config/domain` returns the original `DOMAIN` env var value

---

### Workstream B — Compose: secrets enforcement + DOMAIN wiring

**Files affected:**
- `compose.yml`
- `compose-simple.yml`

#### B.1 Add `DOMAIN` to config-service in `compose.yml`

In the `config-service` service block, add to `environment:`:

```yaml
      - DOMAIN=${DOMAIN:?DOMAIN must be set in .env (e.g. http://localhost:8080)}
```

#### B.2 Switch true secrets to `:?` form in `compose.yml`

Replace the `:-default` fallback with `:?error message` for each true secret. Full list of changes:

```yaml
# config-service
- CONFIG_WRITE_TOKEN=${CONFIG_WRITE_TOKEN:?CONFIG_WRITE_TOKEN must be set in .env}
- DOMAIN=${DOMAIN:?DOMAIN must be set in .env (e.g. http://localhost:8080)}

# auth-service
- DB_PASSWORD=${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD must be set in .env}
- JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set in .env}

# auth-postgres (DB container)
- POSTGRES_PASSWORD=${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD must be set in .env}

# url-service
- DB_PASSWORD=${URL_DB_PASSWORD:?URL_DB_PASSWORD must be set in .env}
- SERVICE_TOKEN=${SERVICE_TOKEN:?SERVICE_TOKEN must be set in .env}

# url-mysql (DB container)
- MYSQL_PASSWORD=${URL_DB_PASSWORD:?URL_DB_PASSWORD must be set in .env}
- MYSQL_ROOT_PASSWORD=${URL_DB_ROOT_PASSWORD:?URL_DB_ROOT_PASSWORD must be set in .env}

# redirect-service
- SERVICE_TOKEN=${SERVICE_TOKEN:?SERVICE_TOKEN must be set in .env}
- IP_HASH_SALT=${IP_HASH_SALT:?IP_HASH_SALT must be set in .env}

# admin-service
- CONFIG_WRITE_TOKEN=${CONFIG_WRITE_TOKEN:?CONFIG_WRITE_TOKEN must be set in .env}
- SERVICE_TOKEN=${SERVICE_TOKEN:?SERVICE_TOKEN must be set in .env}

# analytics-service
- CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD must be set in .env}
- SERVICE_TOKEN=${SERVICE_TOKEN:?SERVICE_TOKEN must be set in .env}

# clickhouse (DB container)
- CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD must be set in .env}
```

**Non-secrets keep `:-default`:**

```yaml
# Examples — keep these as-is:
- PORT=${CONFIG_SERVICE_PORT:-3000}
- LOG_LEVEL=${LOG_LEVEL:-info}
- REDIS_URL=${REDIS_URL:-redis://redis:6379}
- CONFIG_SERVICE_URL=${CONFIG_SERVICE_URL:-http://config-service:3000}
# ... all _SERVICE_URL vars, CACHE_TTL_SECONDS, etc.
```

#### B.3 Apply same changes to `compose-simple.yml`

Mirror the `:?` changes from B.1–B.2 into `compose-simple.yml`.

**Why this matters:** A fresh clone running `docker compose up -d` without a `.env` will now fail with a clear error like:

```
WARN[0000] The "JWT_SECRET" variable is not set. Defaulting to a blank string.
  → Error: variable JWT_SECRET: "JWT_SECRET must be set in .env"
```

This makes the secret requirement explicit at the infrastructure layer, not just in documentation.

**Verify steps:**
1. `mv .env .env.bak && docker compose config 2>&1 | head -5` → shows `:?` error messages
2. `mv .env.bak .env && docker compose config` → succeeds

---

### Workstream C — .gitignore + .env.example

**Files affected:**
- `.gitignore` (new file)
- `.env.example` (new file)
- `.env` (untracked from git, kept locally)

#### C.1 Create `.gitignore`

```
# Secrets — never commit real credentials
.env

# Local development overrides
.env.local
.env.*.local

# Build artifacts
node_modules/
dist/
target/

# OS noise
.DS_Store
```

#### C.2 Untrack `.env` from git

```bash
git rm --cached .env
```

`.env` stays on disk (local dev needs it) but is no longer tracked. After this commit, future contributors who clone the repo will NOT have `.env`. They must create it from `.env.example`.

#### C.3 Create `.env.example`

This file documents every variable consumed anywhere in the stack. It ships in the repo so contributors know exactly what to fill in.

```dotenv
# =============================================================================
# microshort — environment variables
# =============================================================================
# Copy this file to .env and fill in the values before running the stack.
#
#   cp .env.example .env
#
# PRODUCTION NOTE: Never commit .env. Use your deployment platform's secret
# injection mechanism:
#   Docker Swarm : docker secret create / secrets: in compose file
#   Kubernetes   : kubectl create secret generic / envFrom: secretRef:
#   Ansible      : ansible-vault encrypt / vars injection via playbook
#   Terraform    : sensitive variable + remote state backend
# =============================================================================

# ----- Shared domain --------------------------------------------------------
# The public-facing base URL for all short links.
# Set to your public domain in production (e.g. https://sho.rt).
DOMAIN=http://localhost:8080

# ----- Auth service ---------------------------------------------------------
JWT_SECRET=change-me-in-production
AUTH_DB_PASSWORD=change-me-in-production

# ----- URL service ----------------------------------------------------------
URL_DB_PASSWORD=change-me-in-production
URL_DB_ROOT_PASSWORD=change-me-in-production

# ----- Analytics / inter-service token -------------------------------------
# Shared secret for service-to-service calls to analytics-service.
# Must match across: url-service, redirect-service, admin-service, analytics-service.
SERVICE_TOKEN=change-me-in-production

# ----- Redirect service -----------------------------------------------------
# Salt for SHA-256(client_ip + salt) before storing ip_hash in ClickHouse.
# Changing this invalidates all existing ip_hash values.
IP_HASH_SALT=change-me-in-production

# ----- Config service -------------------------------------------------------
# Token required to write (PUT) the domain via config-service or admin-service.
CONFIG_WRITE_TOKEN=change-me-in-production

# ----- ClickHouse -----------------------------------------------------------
CLICKHOUSE_PASSWORD=change-me-in-production
```

**Verify steps:**
1. `git status` → `.env` shows as untracked, not modified
2. `git diff --cached` → only `.gitignore` and `.env.example` added, `.env` removed from index
3. `.env.example` committed; `.env` not committed

---

### Workstream D — envalid startup validation in all Node services

**Files affected:**
- `services/auth-service/package.json`, `src/index.js`
- `services/url-service/package.json`, `src/index.js`
- `services/redirect-service/package.json`, `src/index.js`
- `services/admin-service/package.json`, `src/index.js`
- `services/config-service/package.json`, `src/server.ts`

#### D.1 Why envalid, not dotenv-safe

dotenv-safe requires the `.env.example` file to be present at runtime to know which variables to validate. In Docker, service images contain only `dist/` + production deps — no `.env.example` is copied into the image, so dotenv-safe would throw "example file not found" on boot.

`envalid` validates `process.env` directly against validators declared in code — no file dependency, no runtime file COPY needed, TypeScript-native, calls `process.exit(1)` with a clear table of missing vars. [npm](https://www.npmjs.com/package/envalid) | [github](https://github.com/af/envalid)

#### D.2 Install envalid

```bash
cd services/auth-service     && npm install envalid
cd services/url-service      && npm install envalid
cd services/redirect-service && npm install envalid
cd services/admin-service    && npm install envalid
cd services/config-service   && npm install envalid
```

#### D.3 auth-service — startup validation

Add at the **very top** of `services/auth-service/src/index.js` (before any other imports or app code):

```js
import { cleanEnv, str } from 'envalid';

const env = cleanEnv(process.env, {
  JWT_SECRET:   str({ desc: 'JWT signing secret — never use the default in production' }),
  DB_PASSWORD:  str({ desc: 'PostgreSQL password for auth_db' }),
  REDIS_URL:    str({ default: 'redis://redis:6379', desc: 'Redis connection string for rate limiting' }),
  PORT:         str({ default: '3001' }),
  LOG_LEVEL:    str({ default: 'info' }),
  CONFIG_SERVICE_URL: str({ default: 'http://config-service:3000' }),
});
```

Then replace bare `process.env.JWT_SECRET` etc. with `env.JWT_SECRET` throughout the file.

> **Why `str()` and not `port()` for PORT**: `process.env.PORT` is a string; envalid's `port()` validator also returns a number. Using `str({ default: '...' })` keeps the type consistent with how PORT is already used (`parseInt(process.env.PORT || '3001')`). Either works; str() requires no refactoring of existing parse calls.

#### D.4 url-service — startup validation

```js
import { cleanEnv, str } from 'envalid';

const env = cleanEnv(process.env, {
  DB_PASSWORD:         str({ desc: 'MySQL password for url_db' }),
  SERVICE_TOKEN:       str({ desc: 'Shared service-to-service token for analytics calls' }),
  REDIS_URL:           str({ default: 'redis://redis:6379' }),
  AUTH_SERVICE_URL:    str({ default: 'http://auth-service:3001' }),
  CONFIG_SERVICE_URL:  str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  PORT:                str({ default: '3002' }),
  LOG_LEVEL:           str({ default: 'info' }),
});
```

#### D.5 redirect-service — startup validation

```js
import { cleanEnv, str } from 'envalid';

const env = cleanEnv(process.env, {
  SERVICE_TOKEN:       str({ desc: 'Shared service-to-service token for analytics calls' }),
  IP_HASH_SALT:        str({ desc: 'Salt for SHA-256(client_ip+salt) — changing this invalidates historical ip_hash values' }),
  URL_SERVICE_URL:     str({ default: 'http://url-service:3002' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  REDIS_URL:           str({ default: 'redis://redis:6379' }),
  PORT:                str({ default: '8080' }),
  LOG_LEVEL:           str({ default: 'info' }),
});
```

#### D.6 admin-service — startup validation

```js
import { cleanEnv, str } from 'envalid';

const env = cleanEnv(process.env, {
  SERVICE_TOKEN:       str({ desc: 'Shared service-to-service token for analytics calls' }),
  CONFIG_WRITE_TOKEN:  str({ desc: 'Token required to update domain via config-service' }),
  AUTH_SERVICE_URL:    str({ default: 'http://auth-service:3001' }),
  URL_SERVICE_URL:     str({ default: 'http://url-service:3002' }),
  CONFIG_SERVICE_URL:  str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  PORT:                str({ default: '3003' }),
  LOG_LEVEL:           str({ default: 'info' }),
});
```

#### D.7 config-service — envalid handles initial startup validation

The config-service already has a manual check for `DOMAIN` (Workstream A). Replace those manual `if` checks with envalid:

```typescript
import { cleanEnv, url, str } from 'envalid';

const env = cleanEnv(process.env, {
  DOMAIN:             url({ desc: 'Base URL for short links. Must be a valid URI.' }),
  CONFIG_WRITE_TOKEN: str({ desc: 'Token required to accept PUT /config/domain' }),
  PORT:               str({ default: '3000' }),
  LOG_LEVEL:          str({ default: 'info' }),
});
```

`envalid`'s `url()` validator checks for valid URL format — this replaces the Ajv startup check for `DOMAIN`. **Ajv is still used for PUT /config/domain body validation** (validating user-supplied input at the HTTP layer).

With this, the manual `if (!rawDomain)` and `if (!validateConfig(...))` startup checks from Workstream A are replaced by envalid. The code becomes:

```typescript
// envalid exits the process on failure — if we reach here, DOMAIN is valid
const env = cleanEnv(process.env, { ... });
let currentDomain = env.DOMAIN;
```

**envalid error output on missing required var:**

```
================================
  MISSING or INVALID ENVIRONMENT VARIABLES:
  - JWT_SECRET: Required. JWT signing secret — never use the default in production
================================
```

Process exits with code 1, preventing the service from starting in a misconfigured state.

**Verify steps:**
1. Remove `JWT_SECRET` from env and start auth-service → clear error, process exits 1
2. Set all required vars → service starts normally
3. In Docker (vars injected by compose): service starts, envalid passes silently

---

### Workstream E — quickstart.sh: guard against missing .env

**Files affected:**
- `quickstart.sh`
- `quickstart.ps1`

#### E.1 Add `.env` existence check to `quickstart.sh`

Add at the top of `quickstart.sh`, before `docker compose up -d`:

```bash
# Ensure .env exists before starting — compose will fail on missing secrets otherwise
if [ ! -f .env ]; then
  echo "⚠️  No .env file found. Creating one from .env.example..."
  cp .env.example .env
  echo ""
  echo "  IMPORTANT: .env has been created with placeholder values."
  echo "  Edit .env with real secrets before deploying to production."
  echo "  For local development, the placeholders will work as-is."
  echo ""
fi
```

#### E.2 Update `quickstart.ps1`

Add equivalent check for Windows:

```powershell
if (-not (Test-Path ".env")) {
  Write-Host "No .env file found. Creating one from .env.example..." -ForegroundColor Yellow
  Copy-Item ".env.example" ".env"
  Write-Host ""
  Write-Host "  IMPORTANT: .env has been created with placeholder values." -ForegroundColor Yellow
  Write-Host "  Edit .env with real secrets before deploying to production." -ForegroundColor Yellow
  Write-Host ""
}
```

> **Teaching note:** When `quickstart.sh` copies `.env.example`, the placeholder values (`change-me-in-production`) become the running secrets. The stack will start, and the system works for local demos. But:
> - envalid in each service validates the *presence* of the vars, not their *strength*
> - compose `:?` validation passes because the placeholder is non-empty
> - This is intentional: the lesson is recognising *which* values need replacing and *how* to inject them per platform, not blocking all local dev

---

### Workstream F — Integration tests

**Files affected:**
- `tests/integration/m5.integration.test.js` (new)
- `package.json` (root — add `test:m5` script)

#### F.1 New test file

```js
import { describe, it, expect } from 'vitest';

const CONFIG_URL = 'http://localhost:3000';

describe('M5 — Config-service: env-var driven domain', () => {
  it('GET /config/domain returns a valid domain', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBeTruthy();
    expect(body.domain).toMatch(/^https?:\/\//);
  });

  it('/ready includes current domain', async () => {
    const res = await fetch(`${CONFIG_URL}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBeTruthy();
  });
});

describe('M5 — Config-service: Ajv validation on PUT', () => {
  const writeToken = process.env.CONFIG_WRITE_TOKEN;

  it('rejects PUT with invalid domain format', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: 'not-a-uri' })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/[Vv]alidation/);
  });

  it('rejects PUT without auth token', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'http://example.com' })
    });
    expect(res.status).toBe(401);
  });

  it('accepts PUT with valid domain and returns ephemerality warning', async () => {
    const originalRes = await fetch(`${CONFIG_URL}/config/domain`);
    const original = await originalRes.json();

    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: 'http://test-update.example.com' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toMatch(/ephemeral/i);

    // Restore original domain
    await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: original.domain })
    });
  });
});

describe('M5 — Secrets: services handle missing required vars', () => {
  // These are manual tests — listed here for documentation.
  // Automated: verify the services are running (which means envalid passed)
  it('auth-service is running (envalid passed all required vars)', async () => {
    const res = await fetch('http://localhost:3001/health');
    expect(res.status).toBe(200);
  });

  it('redirect-service is running (IP_HASH_SALT and SERVICE_TOKEN validated)', async () => {
    const res = await fetch('http://localhost:8080/health');
    expect(res.status).toBe(200);
  });
});
```

#### F.2 Root `package.json` — add test script

```json
{
  "scripts": {
    "test:m5": "vitest run --reporter=verbose tests/integration/m5.integration.test.js"
  }
}
```

---

### Workstream G — Documentation updates

**Files affected:**
- `PLANNING.md`
- `CLAUDE.md`
- `README.md`

#### G.1 Update PLANNING.md §5 M5

Replace the current M5 text with:

```markdown
### M5 — Configuration & secrets *(core teaching topic)* ✅ COMPLETE
Goal: make config and secrets a first-class, teachable concern.
- Replace config-service's file-on-disk store with env-var driven config (`DOMAIN`
  env var). config-service reads `DOMAIN` at startup (validated by envalid + Ajv);
  `PUT /config/domain` updates in-memory only and is explicitly ephemeral. This is
  the 12-factor approach: config comes from the environment, survives restarts, and
  is consistent across replicas.
- Validate `domain` against `config.schema.json` via Ajv v8 + ajv-formats on
  startup and on every `PUT /config/domain` request (CR 7.2).
- Remove committed secrets from `.env` (git-untracked); provide `.env.example`
  with placeholders; switch true secrets in compose to `:?` form so missing vars
  fail loudly; add `envalid` to every Node service for startup fail-fast (CR 2.6).
```

#### G.2 Update CLAUDE.md — secrets section

Add a new sub-section under "Notes / gotchas":

```markdown
- **Secrets are injected via `.env`** (Docker Compose dev) or your deployment
  platform's secret mechanism (K8s Secret, Swarm secret, Ansible Vault). The
  `.env.example` file is the authoritative list. Copy it to `.env` and fill in
  real values before running locally. The stack will not start without a populated
  `.env` (compose `:?` enforcement).
- **config-service reads `DOMAIN` from the environment**, not from a file.
  `PUT /config/domain` changes the in-memory value only — the change resets on
  container restart. To persist a domain change across restarts, update `DOMAIN`
  in `.env` and restart config-service.
```

---

## 3. File-Change Summary

| Service/Area | File | Change |
|---|---|---|
| **config-service** | `src/server.ts` | Replace loadConfig/saveConfig/getConfig file I/O with env-var state; add Ajv validation; replace manual DOMAIN check with envalid; update PUT (ephemeral + warning); update /ready |
| **config-service** | `tsconfig.json` | Add `resolveJsonModule: true` |
| **config-service** | `package.json` | Add `ajv`, `ajv-formats`, `envalid` |
| **config-service** | `config.json` | **Deleted** |
| **config-service** | `Dockerfile` | Remove `COPY config.json` |
| **auth-service** | `src/index.js` | Add envalid startup validation |
| **auth-service** | `package.json` | Add `envalid` |
| **url-service** | `src/index.js` | Add envalid startup validation |
| **url-service** | `package.json` | Add `envalid` |
| **redirect-service** | `src/index.js` | Add envalid startup validation |
| **redirect-service** | `package.json` | Add `envalid` |
| **admin-service** | `src/index.js` | Add envalid startup validation |
| **admin-service** | `package.json` | Add `envalid` |
| **root** | `.gitignore` | New: excludes `.env`, `node_modules/`, `dist/`, `target/` |
| **root** | `.env.example` | New: all secret placeholders with comments |
| **root** | `.env` | Untracked (`git rm --cached .env`) |
| **root** | `compose.yml` | True secrets → `:?` form; add `DOMAIN` for config-service |
| **root** | `compose-simple.yml` | Mirror compose.yml changes |
| **root** | `quickstart.sh` | Add `.env` existence check + auto-copy from `.env.example` |
| **root** | `quickstart.ps1` | Same for Windows |
| **root** | `tests/integration/m5.integration.test.js` | New: M5 integration tests |
| **root** | `package.json` | Add `test:m5` script |
| **root** | `PLANNING.md` | Update M5 status and description to match implementation |
| **root** | `CLAUDE.md` | Add secrets injection guidance |

---

## 4. Commit Sequence

```
1. chore(config): delete config.json; add .gitignore and .env.example; untrack .env
   — establishes secrets hygiene baseline before any service code changes

2. feat(compose): switch true secrets to :? form; wire DOMAIN to config-service
   — compose.yml + compose-simple.yml; quickstart.sh/.ps1 .env guard

3. feat(config-service): env-var driven config + Ajv validation
   — resolveJsonModule; envalid at startup; Ajv on PUT; ephemeral PUT; /ready simplified

4. feat(all-node): add envalid startup validation
   — auth, url, redirect, admin services; each fails fast on missing required vars

5. test: add M5 integration test suite
   — GET /config/domain, Ajv PUT validation, ephemerality warning, services healthy

6. docs: update PLANNING.md M5 status + CLAUDE.md secrets guidance
```

---

## 5. Definition of Done

- [ ] `docker compose up -d` without `.env` → compose exits with `:?` error messages listing missing secrets
- [ ] `cp .env.example .env && docker compose up -d` → all services start and reach `(healthy)`
- [ ] `curl http://localhost:3000/config/domain` → returns `{ "domain": "..." }` matching the `DOMAIN` in `.env`
- [ ] `curl -X PUT http://localhost:3000/config/domain -H "X-Service-Token: ..." -d '{"domain":"not-a-uri"}'` → `400` with validation error
- [ ] `curl -X PUT http://localhost:3000/config/domain -H "X-Service-Token: ..." -d '{"domain":"http://new.example.com"}'` → `200` with `"warning": "... ephemeral ..."`
- [ ] `docker compose restart config-service && curl http://localhost:3000/config/domain` → returns original `DOMAIN` value from `.env` (PUT did not persist)
- [ ] `cat config-service/config.json` → no such file (deleted)
- [ ] Remove `JWT_SECRET` from `.env`, run `docker compose up auth-service` → exits with envalid error message
- [ ] `docker compose logs auth-service | head -5` — envalid passes silently when all vars present
- [ ] `git status` → `.env` shows as untracked; `git log --oneline -1 -- .env` → only the "untrack" commit appears
- [ ] `npm run test:m5` from root → all tests green against a running stack

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| quickstart.sh copies `.env.example` with placeholders; students run with `change-me-in-production` as JWT_SECRET | High | Low for local dev, critical for production | Comments in `.env.example` and quickstart output explicitly warn about production; compose `:?` passes because placeholder is non-empty (intentional for onboarding UX) |
| envalid ESM/CJS mismatch in Node services (all are `"type": "module"`) | Medium | Medium | envalid ships both ESM and CJS; `import { cleanEnv, str } from 'envalid'` works in ESM. For config-service (TypeScript + CJS), `import` is correct via `esModuleInterop: true` |
| Ajv `format: "uri"` allows `http://localhost` (valid URI but not a "real" domain) | Low | Low | For local dev, `http://localhost:8080` is exactly what we want; production validation is the deployment's responsibility, not the service's |
| `resolveJsonModule` changes tsc output for JSON imports | Low | Low | With `"module": "CommonJS"`, JSON is inlined into the compiled JS. No runtime file needed. Test with `npm run build` in config-service |
| Analytics-service Spring Boot fails to start if SERVICE_TOKEN is a placeholder | Low | Low | Spring Boot `@Value` accepts any non-empty string; placeholder values work |
| Removing `config.json` breaks config-service tests that read the file | Medium | Low | config-service tests use `process.env.CONFIG_PATH` to override the file path; with env-var driven config, these tests need updating to pass `DOMAIN` env var instead. Update tests in the same commit as server.ts |
| `:?` in compose breaks `docker compose config` dry-run without `.env` | Low | Low | Document: always set up `.env` before compose operations. `quickstart.sh` guards this |

---

## 7. Out of Scope for M5

| Item | Notes |
|------|-------|
| Docker secrets / Swarm secrets integration | Deployment-layer concern; `.env.example` documents the injection story but does not implement a specific platform's secret mechanism |
| Kubernetes Secret manifests | Same — out of scope per PLANNING.md §7 |
| Secret rotation tooling | Out of scope; rotate by updating `.env` and restarting affected services |
| Per-service `.env` files for local development | All services share the root `.env` via docker compose; for direct `npm run dev`, developers set env vars in their shell or create a service-level `.env`. Not standardised here. |
| Config-service Swagger/OpenAPI docs update | The OpenAPI spec inline in `server.ts` should note the ephemerality of PUT, but this is a docs-only change that can be done as part of M7 |
| Multi-setting config (beyond `domain`) | Config-service currently only manages `domain`. Adding more settings follows the same env-var pattern but is not M5 scope |
