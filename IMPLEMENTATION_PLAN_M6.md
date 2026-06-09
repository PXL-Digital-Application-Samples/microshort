# IMPLEMENTATION PLAN — M6: Admin UI & API Consistency

> **Status**: Ready to implement
> **Prerequisite**: M1–M3 and M5 complete. M6 is **independent of M4** — much of M4's admin-service work (timeouts, dashboard cache, structured logging, graceful shutdown, Prometheus metrics, `/ready`) is already present in the code. M6 proceeds against the current codebase without waiting for M4 to be formally closed.
> **Source of truth for scope**: PLANNING.md §6 M6; CODE_REVIEW.md CR 4.2, CR 4.4, CR 5.1, CR 5.2

---

## 0. Scope, Findings, and Locked Decisions

### 0.1 What M6 fixes

| Finding | Description | Workstream |
|---------|-------------|------------|
| CR 5.1 | Admin-UI API base URL hard-coded to `http://localhost:3003`; breaks on any non-localhost host | A |
| CR 5.2 | VanJS and htm loaded from public CDNs at runtime; no SRI, no version pinning for jsdelivr `gh/` path, offline breaks | B |
| CR 4.2 | `snake_case` vs `camelCase` across the admin API surface; UI must special-case shapes per endpoint | C |
| CR 4.4 | `GET /admin/users/:userId` returns 501; `GET /admin/search/urls` fetches all rows and filters in-process | D |

### 0.2 Locked design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime config injection | **`/config.js` endpoint** on server.js | server.js renders a tiny JS snippet that sets `window.ADMIN_API_BASE` from the `ADMIN_API_URL` env var. `index.html` loads it via `<script src="/config.js">`. Zero dependencies, no build step, no new containers. |
| CDN replacement strategy | **Vendor locally** into `services/admin-ui/vendor/` | Serve both libraries from the UI's own static server. Preserves the zero-build approach while removing CDN and offline dependencies entirely. |
| VanJS version | **Upgrade 1.5.2 → 1.6.0** at vendor time | 1.6.0 is the current stable release; API is backwards-compatible. No reason to vendor an outdated version. |
| htm version | **3.1.1** (latest, unchanged since 2022) | Stable; no changes needed. |
| camelCase standard | **camelCase throughout** — fix at source, not in the aggregator | API owners (url-service, auth-service) map DB snake_case to camelCase before returning. admin-service and admin-ui consume one dialect. |
| `getAllUsers` role field | **Add `role` to `SELECT`** in auth-service | `Users.js` checks `user.id === 1` as a pre-M2 proxy for admin. Fix it to use `user.role === 'admin'` — requires `role` to be returned. |
| `/admin/users/:userId` stub | **Formally retire** — update note to reference M7 | Implementing the full user-detail flow needs new endpoints in both auth-service and url-service; scope is disproportionate for a consistency milestone. |
| `/admin/search/urls` | **Push filter to url-service DB** | Add `?q=` param to url-service `GET /admin/urls`; admin-service forwards it. Removes the fetch-all-then-filter anti-pattern and teaches "filter at the source". |

### 0.3 Current state: casing bug confirmed

The `postgres` npm client used in `auth-service/src/db.js` has **no camelCase transform configured** (the `sql = postgres({ ... })` call has no `transform` option). This means `getAllUsers()` returns rows with `created_at` (snake_case from SQL), but `Users.js:58` reads `user.createdAt` → `undefined`. Date column in the Users view is currently always blank.

---

## 1. Current-State Facts

### 1.1 admin-ui

- `app.js:17`: `const API_BASE = 'http://localhost:3003';` — hard-coded, baked into the static file.
- `index.html:14-15`: VanJS loaded from `https://cdn.jsdelivr.net/gh/vanjs-org/van/public/van-1.5.2.min.js`; htm loaded from `https://unpkg.com/htm@3/dist/htm.module.js`. No SRI attribute on either.
- `server.js`: plain Express static server, `express.static(__dirname)`. No env var injected into served files. No route for runtime config.
- `compose.yml` admin-ui block: only `PORT=3004` in `environment:`. No `ADMIN_API_URL`.

### 1.2 camelCase inconsistencies

| Endpoint | Field | Current shape | Expected (M6) |
|----------|-------|---------------|---------------|
| url-service `GET /admin/stats` → `topUrls` | destination | `long_url` (raw DB) | `longUrl` |
| auth-service `GET /admin/users` → `users[]` | date | `created_at` (raw DB) | `createdAt` |
| auth-service `GET /admin/users` → `users[]` | admin flag | `(missing)` | `role` |
| Dashboard.js TopURLsList | destination field | reads `url.long_url` | dead reference — remove |
| Users.js badge | admin check | `user.id === 1` | `user.role === 'admin'` |
| app.js login hint | text | "First user (ID 1) is admin" | reflects role-based auth |

Note: `url-service GET /admin/urls` already returns camelCase (`longUrl`, `shortUrl`, `userId`, `createdAt`). No change needed there.

### 1.3 Admin API stubs

- `admin-service GET /admin/users/:userId` (`index.js:240`): always returns `501 Not Implemented`.
- `admin-service GET /admin/search/urls` (`index.js:305`): fetches `URL_SERVICE_URL/admin/urls` (up to 1000 rows) and filters in-process. Not called by `admin-ui` — the UI does its own client-side filtering in `URLs.js`.
- `url-service GET /admin/urls` (`index.js:299`): fetches all rows with no `?q` filter support (`getAllUrls()` = `SELECT * LIMIT 1000`).

---

## 2. Workstreams

---

### Workstream A — admin-ui runtime config via `/config.js`

**Files affected:**
- `services/admin-ui/server.js`
- `services/admin-ui/app.js`
- `services/admin-ui/index.html`
- `compose.yml`
- `compose-simple.yml`
- `.env.example`

#### A.1 Add `/config.js` route to `server.js`

Add before the SPA catch-all `app.get('*', ...)`:

```js
// Serves runtime config to the browser. ADMIN_API_URL must be the
// host-side URL that browsers use to reach admin-service.
app.get('/config.js', (req, res) => {
  const base = process.env.ADMIN_API_URL || 'http://localhost:3003';
  res.type('application/javascript');
  res.send(`window.ADMIN_API_BASE = ${JSON.stringify(base)};`);
});
```

#### A.2 Update `index.html` — load `/config.js` before module script

Add a `<script>` tag inside `<body>`, before the `<script type="module">` block:

```html
<!-- Runtime config: sets window.ADMIN_API_BASE from server env var -->
<script src="/config.js"></script>
```

The final `<body>` section should look like:

```html
<body>
    <div id="app"></div>

    <!-- Runtime config: sets window.ADMIN_API_BASE from server env var -->
    <script src="/config.js"></script>

    <script type="module">
        import van from "/vendor/van.min.js";
        import htm from "/vendor/htm.module.js";
        ...
    </script>
</body>
```

(The vendor paths come from Workstream B.)

#### A.3 Update `app.js` — read from `window.ADMIN_API_BASE`

Replace the hard-coded constant on line 17:

```js
// Before:
const API_BASE = 'http://localhost:3003';

// After:
const API_BASE = window.ADMIN_API_BASE || 'http://localhost:3003';
```

The fallback ensures `npm run dev` (running server.js directly without env var set) still works out of the box.

#### A.4 Update `compose.yml` — inject `ADMIN_API_URL` for admin-ui

In the `admin-ui` service block:

```yaml
admin-ui:
  build: ./services/admin-ui
  ports:
    - "3004:3004"
  environment:
    - PORT=3004
    - ADMIN_API_URL=${ADMIN_API_URL:-http://localhost:3003}
```

`ADMIN_API_URL` defaults to `http://localhost:3003` — the correct host-side URL for local dev (browsers call `localhost`, not `admin-service`).

#### A.5 Mirror change in `compose-simple.yml`

Apply the same `ADMIN_API_URL` addition to the admin-ui block in `compose-simple.yml`.

#### A.6 Add `ADMIN_API_URL` to `.env.example`

```dotenv
# ----- Admin UI ---------------------------------------------------------------
# Public (browser-reachable) URL for the admin service.
# In local dev this is always http://localhost:3003.
# In production, set to your admin-service public URL.
ADMIN_API_URL=http://localhost:3003
```

**Verify steps:**
1. `docker compose up -d --build admin-ui` → `GET http://localhost:3004/config.js` returns `window.ADMIN_API_BASE = "http://localhost:3003";`
2. Open `http://localhost:3004` in a browser → network tab shows API calls going to `localhost:3003` (not hard-coded `localhost:3003` by coincidence — driven by the injected value)
3. Set `ADMIN_API_URL=http://custom.example:3003` in `.env`, restart → `/config.js` reflects the new value

---

### Workstream B — Vendor VanJS 1.6.0 + htm 3.1.1

**Files affected:**
- `services/admin-ui/vendor/van.min.js` (new)
- `services/admin-ui/vendor/htm.module.js` (new)
- `services/admin-ui/index.html`
- `services/admin-ui/.dockerignore` (no change needed — `COPY . .` in Dockerfile already copies `vendor/`)

#### B.1 Create `vendor/` directory and download the files

```bash
mkdir -p services/admin-ui/vendor

# VanJS 1.6.0 — ESM module build
curl -L "https://cdn.jsdelivr.net/gh/vanjs-org/van/public/van-1.6.0.min.js" \
  -o services/admin-ui/vendor/van.min.js

# htm 3.1.1 — ESM module build
curl -L "https://unpkg.com/htm@3.1.1/dist/htm.module.js" \
  -o services/admin-ui/vendor/htm.module.js
```

> **Corporate SSL proxy note:** If `curl` fails with a certificate error (common behind TLS-intercepting proxies — see `feedback_env.md`), add `-k` to skip verification, or `--cacert <corp-ca.pem>` if your org distributes a CA bundle. Alternatively, download the files in a browser and copy them manually.

Commit both files. They are small (VanJS is ~1 kB, htm is ~2 kB minified) and deliberately vendor-committed to make the repo self-contained.

#### B.2 Update `index.html` — replace CDN imports with local paths

Replace the two CDN import statements inside the `<script type="module">` block:

```html
<!-- Before: -->
import van from "https://cdn.jsdelivr.net/gh/vanjs-org/van/public/van-1.5.2.min.js";
import htm from "https://unpkg.com/htm@3/dist/htm.module.js";

<!-- After: -->
import van from "/vendor/van.min.js";
import htm from "/vendor/htm.module.js";
```

No SRI attribute is needed for same-origin files.

**Verify steps:**
1. `docker compose up -d --build admin-ui` → no CDN requests in browser network tab
2. Disconnect from internet (or block `cdn.jsdelivr.net` / `unpkg.com` in `/etc/hosts`) → admin-ui still loads fully
3. `docker compose up -d --build admin-ui` → no CDN requests during Docker build phase (already true — Dockerfile doesn't fetch at build time)

---

### Workstream C — camelCase standardization

**Files affected:**
- `services/auth-service/src/db.js`
- `services/url-service/src/db.js`
- `services/admin-ui/app.js`
- `services/admin-ui/components/Dashboard.js`
- `services/admin-ui/components/Users.js`

#### C.1 auth-service `getAllUsers` — add `role`, map `created_at` → `createdAt`

In `services/auth-service/src/db.js`, rewrite `getAllUsers()`:

```js
// Before:
export async function getAllUsers() {
  const users = await sql`
    SELECT id, email, created_at
    FROM users
    ORDER BY created_at DESC
  `;
  return users;
}

// After:
export async function getAllUsers() {
  const users = await sql`
    SELECT id, email, role, created_at
    FROM users
    ORDER BY created_at DESC
  `;
  return users.map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    createdAt: u.created_at
  }));
}
```

This fixes two issues:
- `Users.js` `user.createdAt` was always `undefined` (CR 4.2 casing bug)
- `Users.js` admin badge was checking `user.id === 1` (pre-M2 leftover); now `user.role` is available

#### C.2 url-service `getUrlStats` — map `topUrls` to camelCase

In `services/url-service/src/db.js`, update the `topUrls` mapping in `getUrlStats()`:

```js
// Before:
return {
  totalUrls: parseInt(totalStats.total_urls),
  totalClicks: parseInt(totalStats.total_clicks || 0),
  recentUrls: parseInt(recentStats.recent_urls),
  topUrls: topUrls
};

// After:
return {
  totalUrls: parseInt(totalStats.total_urls),
  totalClicks: parseInt(totalStats.total_clicks || 0),
  recentUrls: parseInt(recentStats.recent_urls),
  topUrls: topUrls.map(u => ({
    slug: u.slug,
    longUrl: u.long_url,
    clicks: u.clicks
  }))
};
```

`topUrls` is returned by url-service's own `GET /admin/stats` endpoint. admin-service currently sources top slugs from analytics (post-M3), so this field is not consumed by the dashboard, but it's called directly by anything that talks to url-service and should speak one dialect.

#### C.3 Dashboard.js — remove dead `url.long_url` reference

After M3, admin-service's `topUrls` comes from analytics (`{ slug, clicks }`) — `long_url` / `longUrl` is never present. The `url.long_url` reference in `TopURLsList` has always produced `undefined` since M3 landed.

**Intentional product decision:** The analytics-service response does not include the destination URL; enriching the top-URL list with `longUrl` would require a per-slug round-trip to url-service — out of scope for M6. The dashboard Top URLs panel shows slug + click count only.

In `services/admin-ui/components/Dashboard.js`, remove the dead `<div class="url-long">` line:

```js
// Before:
urls.map(url => html`
    <div class="url-item">
        <span class="url-slug">${url.slug}</span>
        <span class="url-clicks">${url.clicks} clicks</span>
        <div class="url-long">${url.long_url}</div>
    </div>
`)

// After:
urls.map(url => html`
    <div class="url-item">
        <span class="url-slug">${url.slug}</span>
        <span class="url-clicks">${url.clicks} clicks</span>
    </div>
`)
```

#### C.4 Users.js — use `user.role` for admin badge, fix date

In `services/admin-ui/components/Users.js`, update the role badge:

```js
// Before:
<span class=${user.id === 1 ? 'badge badge-admin' : 'badge'}>
    ${user.id === 1 ? 'Admin' : 'User'}
</span>

// After:
<span class=${user.role === 'admin' ? 'badge badge-admin' : 'badge'}>
    ${user.role === 'admin' ? 'Admin' : 'User'}
</span>
```

Date display is automatically fixed by the `getAllUsers` change in C.1 — `user.createdAt` will now be populated.

#### C.5 app.js — update login hint text

In `services/admin-ui/app.js`, update the login hint at line 93:

```js
// Before:
<p class="hint">
    First user (ID 1) is admin. Use their API key.
</p>

// After:
<p class="hint">
    Admin-role users only. Use an API key from an admin account.
</p>
```

This removes the pre-M2 `user_id === 1` reference from user-visible text.

**Verify steps (C workstream):**
1. `GET http://localhost:3001/admin/users` (with admin key) → every user object has `createdAt` (ISO string) and `role` (`"admin"` or `"user"`)
2. `GET http://localhost:3002/admin/stats` (with admin key) → `topUrls` array entries have `longUrl` (camelCase), not `long_url`
3. Open admin-ui Users page → date column shows formatted dates; admin badge reads from `role` field
4. Open admin-ui Dashboard → Top URLs list renders without console errors (no `undefined` field access)

---

### Workstream D — Admin API stubs

**Files affected:**
- `services/url-service/src/db.js`
- `services/url-service/src/index.js`
- `services/admin-service/src/index.js`

#### D.1 `GET /admin/users/:userId` — update retirement note

In `services/admin-service/src/index.js`, update the 501 handler to reference M7:

```js
app.get('/admin/users/:userId', validateAdminKey, async (req, res) => {
  res.status(501).json({
    error: 'Not implemented',
    note: 'User-detail view requires new endpoints in auth-service and url-service. '
        + 'Tracked for M7.'
  });
});
```

No behaviour change; the note is updated from the vague "would need…" to a clear future reference.

#### D.2 url-service — add `?q=` filter to `GET /admin/urls`

Add a `searchUrls(q)` function to `services/url-service/src/db.js`:

```js
export async function searchUrls(q) {
  const pattern = `%${q}%`;
  const [rows] = await pool.execute(
    'SELECT * FROM urls WHERE slug LIKE ? OR long_url LIKE ? ORDER BY created_at DESC LIMIT 100',
    [pattern, pattern]
  );
  return rows;
}
```

In `services/url-service/src/index.js`, update the `GET /admin/urls` handler to accept an optional `?q` query parameter:

```js
app.get('/admin/urls', async (req, res) => {
  // ... (existing admin key validation unchanged) ...

  const { q } = req.query;
  const rawUrls = q ? await searchUrls(q) : await getAllUrls();
  const domain = await getDomain(req.id);

  const formattedUrls = rawUrls.map(u => ({
    id: u.id,
    shortUrl: `${domain}/${u.slug}`,
    longUrl: u.long_url,
    slug: u.slug,
    clicks: u.clicks,
    userId: u.user_id,
    createdAt: u.created_at
  }));

  res.json({ urls: formattedUrls });
});
```

Also import `searchUrls` at the top of `index.js`:

```js
import { ..., searchUrls } from './db.js';
```

#### D.3 admin-service — forward `?q` in `GET /admin/search/urls`

Update `services/admin-service/src/index.js` to forward the query to url-service instead of fetching all and filtering:

```js
app.get('/admin/search/urls', validateAdminKey, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const response = await fetch(
      `${URL_SERVICE_URL}/admin/urls?q=${encodeURIComponent(q)}`,
      {
        headers: { 'X-API-Key': req.headers['x-api-key'], 'x-request-id': req.id },
        signal: AbortSignal.timeout(2000)
      }
    );

    if (!response.ok) {
      throw new Error('Failed to search URLs');
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    req.log.error({ err }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});
```

The in-process `data.urls.filter(...)` is removed entirely.

**Verify steps (D workstream):**
1. `GET http://localhost:3003/admin/users/1` (with admin key) → `501` with updated note referencing M7
2. `GET http://localhost:3003/admin/search/urls?q=test` → hits url-service DB filter, returns `{ urls: [...] }` with at most 100 results
3. `GET http://localhost:3003/admin/search/urls?q=` (empty) → `400 Search query required`
4. `GET http://localhost:3002/admin/urls?q=abc` → returns only URLs whose slug or long_url contains "abc"
5. `GET http://localhost:3002/admin/urls` (no q) → still returns all URLs (backwards-compatible)

---

### Workstream E — Integration tests

**Files affected:**
- `tests/integration/m6.integration.test.js` (new)
- `package.json` (root) — add `test:m6` script

#### E.1 New test file

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, register, createApiKey, resetDb, uniqueEmail } from './helpers.js';

const AUTH_URL  = BASE.auth;
const URL_URL   = BASE.urls;
const ADMIN_URL = BASE.admin;
const UI_URL    = 'http://localhost:3004';

let adminKey;

beforeAll(async () => {
  // Truncate users so the first registration in this suite gets the admin role.
  // Pattern mirrors m4.integration.test.js "M4 — Admin dashboard & cache".
  resetDb();
  const { token } = await register(uniqueEmail('m6admin'));
  const { apiKey } = await createApiKey(token, 'm6-admin-key');
  adminKey = apiKey;
});

// ── CR 5.1: Runtime config ──────────────────────────────────────────────────
describe('M6 — admin-ui: runtime config endpoint', () => {
  it('GET /config.js returns valid JS that sets window.ADMIN_API_BASE', async () => {
    const res = await fetch(`${UI_URL}/config.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body).toMatch(/window\.ADMIN_API_BASE\s*=/);
    expect(body).toMatch(/^window\.ADMIN_API_BASE\s*=\s*"https?:\/\//m);
  });
});

// ── CR 5.2: Vendored libraries ──────────────────────────────────────────────
describe('M6 — admin-ui: vendored libraries', () => {
  it('GET /vendor/van.min.js returns JS content (not a redirect to CDN)', async () => {
    const res = await fetch(`${UI_URL}/vendor/van.min.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
    // Must not be an HTML error page
    expect(body).not.toMatch(/<html/i);
  });

  it('GET /vendor/htm.module.js returns JS content (not a redirect to CDN)', async () => {
    const res = await fetch(`${UI_URL}/vendor/htm.module.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toMatch(/<html/i);
  });

  it('index.html does not reference CDN URLs', async () => {
    const res = await fetch(`${UI_URL}/`);
    const body = await res.text();
    expect(body).not.toContain('cdn.jsdelivr.net');
    expect(body).not.toContain('unpkg.com');
  });
});

// ── CR 4.2: camelCase API consistency ───────────────────────────────────────
describe('M6 — camelCase API consistency', () => {
  it('auth-service GET /admin/users returns createdAt (camelCase) and role', async () => {
    const res = await fetch(`${AUTH_URL}/admin/users`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const { users } = await res.json();
    expect(users.length).toBeGreaterThan(0);
    const user = users[0];
    expect(user).toHaveProperty('createdAt');
    expect(user).toHaveProperty('role');
    // createdAt should parse as a date
    expect(new Date(user.createdAt).getFullYear()).toBeGreaterThan(2000);
  });

  it('url-service GET /admin/stats topUrls entries use longUrl (camelCase)', async () => {
    const res = await fetch(`${URL_URL}/admin/stats`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    if (data.topUrls && data.topUrls.length > 0) {
      const entry = data.topUrls[0];
      expect(entry).toHaveProperty('longUrl');
      expect(entry).not.toHaveProperty('long_url');
    }
  });

  it('admin-service GET /admin/urls returns camelCase fields', async () => {
    const res = await fetch(`${ADMIN_URL}/admin/urls`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const { urls } = await res.json();
    if (urls.length > 0) {
      expect(urls[0]).toHaveProperty('longUrl');
      expect(urls[0]).toHaveProperty('shortUrl');
      expect(urls[0]).toHaveProperty('createdAt');
      expect(urls[0]).not.toHaveProperty('long_url');
    }
  });
});

// ── CR 4.4: Admin API stubs ──────────────────────────────────────────────────
describe('M6 — admin API stubs', () => {
  it('GET /admin/users/:userId returns 501 with M7 note', async () => {
    const res = await fetch(`${ADMIN_URL}/admin/users/1`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.note).toMatch(/M7/i);
  });

  it('GET /admin/search/urls?q= requires non-empty query', async () => {
    const res = await fetch(`${ADMIN_URL}/admin/search/urls`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(400);
  });

  it('GET /admin/search/urls?q=<term> returns filtered results from url-service DB', async () => {
    const res = await fetch(`${ADMIN_URL}/admin/search/urls?q=http`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('urls');
    expect(Array.isArray(data.urls)).toBe(true);
  });

  it('url-service GET /admin/urls?q= filters by slug or long_url', async () => {
    const res = await fetch(`${URL_URL}/admin/urls?q=http`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const { urls } = await res.json();
    expect(Array.isArray(urls)).toBe(true);
    // Every returned URL should match the query
    urls.forEach(u => {
      const matchesSlug = u.slug.includes('http');
      const matchesLong = u.longUrl.toLowerCase().includes('http');
      expect(matchesSlug || matchesLong).toBe(true);
    });
  });
});
```

#### E.2 Root `package.json` — add test script

```json
{
  "scripts": {
    "test:m6": "vitest run --reporter=verbose tests/integration/m6.integration.test.js"
  }
}
```

---

### Workstream F — Documentation

**Files affected:**
- `PLANNING.md`
- `CLAUDE.md`

#### F.1 Update `PLANNING.md` — mark M6 complete

Replace the M6 entry:

```markdown
### M6 — Admin UI & API consistency ✅ COMPLETE
Goal: keep the zero-build (VanJS + htm) UI, but make it work anywhere and have
the API speak one dialect (CR §8.2).
- Make the admin-ui API base URL runtime-configurable via a `/config.js` endpoint
  served by the UI server, seeded from `ADMIN_API_URL` env var (CR 5.1).
- Vendor VanJS 1.6.0 and htm 3.1.1 into the repo and serve them from the UI's own
  static server (CR 5.2); UI works offline, CDN-free, and with version pinning.
- Standardise the admin API on camelCase end-to-end: url-service `topUrls` maps
  `long_url` → `longUrl`; auth-service `getAllUsers` adds `role` and maps
  `created_at` → `createdAt`; admin-ui updated to consume consistent shapes (CR 4.2).
- Formally retire `GET /admin/users/:userId` stub (M7); push `GET /admin/search/urls`
  filter to url-service DB via `?q=` param — removes fetch-all-then-filter (CR 4.4).
```

#### F.2 Update `CLAUDE.md` — admin-ui runtime config note

Add a bullet under "Notes / gotchas":

```markdown
- **admin-ui API base URL** is runtime-configurable via `ADMIN_API_URL` env var
  (defaults to `http://localhost:3003`). The UI server serves `GET /config.js`
  which sets `window.ADMIN_API_BASE` in the browser. To point the dashboard at a
  different admin-service host, set `ADMIN_API_URL` in `.env` and restart admin-ui.
- **VanJS and htm are vendored** in `services/admin-ui/vendor/`. To upgrade either
  library: download the new minified file, replace the vendored copy, update the
  version comment in `index.html`.
```

---

## 3. File-Change Summary

| Service / Area | File | Change |
|----------------|------|--------|
| **admin-ui** | `server.js` | Add `GET /config.js` route — renders `window.ADMIN_API_BASE` from env |
| **admin-ui** | `app.js` | `API_BASE` reads `window.ADMIN_API_BASE`; update login hint text |
| **admin-ui** | `index.html` | Add `<script src="/config.js">` before module block; replace CDN imports with `/vendor/` paths |
| **admin-ui** | `vendor/van.min.js` | **New** — VanJS 1.6.0 ESM build (vendored) |
| **admin-ui** | `vendor/htm.module.js` | **New** — htm 3.1.1 ESM build (vendored) |
| **admin-ui** | `components/Dashboard.js` | Remove dead `url.long_url` field from TopURLsList |
| **admin-ui** | `components/Users.js` | Admin badge: `user.role === 'admin'` instead of `user.id === 1` |
| **auth-service** | `src/db.js` | `getAllUsers`: add `role` to SELECT; map `created_at` → `createdAt` |
| **url-service** | `src/db.js` | `getUrlStats` `topUrls`: map `long_url` → `longUrl`; add `searchUrls(q)` |
| **url-service** | `src/index.js` | `GET /admin/urls`: accept optional `?q=` param, call `searchUrls` when present |
| **admin-service** | `src/index.js` | `GET /admin/search/urls`: forward `?q` to url-service, remove in-process filter; update `/admin/users/:userId` 501 note |
| **root** | `compose.yml` | admin-ui: add `ADMIN_API_URL=${ADMIN_API_URL:-http://localhost:3003}` |
| **root** | `compose-simple.yml` | Mirror above |
| **root** | `.env.example` | Add `ADMIN_API_URL=http://localhost:3003` with comment |
| **root** | `tests/integration/m6.integration.test.js` | **New** — CR 5.1/5.2/4.2/4.4 integration tests |
| **root** | `package.json` | Add `test:m6` script |
| **root** | `PLANNING.md` | Mark M6 complete; update description |
| **root** | `CLAUDE.md` | Add admin-ui config + vendoring notes |

---

## 4. Commit Sequence

```
1. feat(admin-ui): vendor VanJS 1.6.0 and htm 3.1.1 locally
   — download vendor/van.min.js + vendor/htm.module.js; update index.html imports

2. feat(admin-ui): runtime-configurable API base via /config.js
   — server.js GET /config.js; app.js reads window.ADMIN_API_BASE; update login hint
   — compose.yml + compose-simple.yml: ADMIN_API_URL env var; .env.example entry

3. fix(auth-service): add role + camelCase createdAt to getAllUsers
   — getAllUsers selects role; maps created_at → createdAt in returned objects

4. fix(url-service): camelCase topUrls in getUrlStats; add ?q= filter to /admin/urls
   — getUrlStats maps long_url → longUrl; new searchUrls(q) DB helper
   — GET /admin/urls accepts optional ?q= and calls searchUrls when present

5. fix(admin-service): forward ?q to url-service; update /admin/users/:id retirement note
   — GET /admin/search/urls forwards ?q=, removes in-process filter
   — GET /admin/users/:userId 501 updated to reference M7

6. fix(admin-ui): remove dead url.long_url reference; fix role badge in Users
   — Dashboard.js: drop long_url div from TopURLsList
   — Users.js: badge uses user.role === 'admin'

7. test: add M6 integration test suite
   — m6.integration.test.js; root package.json test:m6 script

8. docs: mark M6 complete in PLANNING.md; add admin-ui config notes to CLAUDE.md
```

---

## 5. Definition of Done

- [ ] `GET http://localhost:3004/config.js` → `window.ADMIN_API_BASE = "http://localhost:3003";`
- [ ] `GET http://localhost:3004/vendor/van.min.js` → 200, JS content, no CDN redirect
- [ ] `GET http://localhost:3004/vendor/htm.module.js` → 200, JS content, no CDN redirect
- [ ] `GET http://localhost:3004/` (view page source) → no `cdn.jsdelivr.net` or `unpkg.com` references
- [ ] Admin UI loads and functions fully with internet connectivity blocked
- [ ] `GET http://localhost:3001/admin/users` (admin key) → `users[*].createdAt` populated (not `undefined`); `users[*].role` present
- [ ] `GET http://localhost:3002/admin/stats` (admin key) → `topUrls[*].longUrl` present; no `topUrls[*].long_url`
- [ ] Admin UI Users page: dates display correctly; admin badge reads from `role` field
- [ ] `GET http://localhost:3003/admin/users/1` (admin key) → `501` body mentions M7
- [ ] `GET http://localhost:3003/admin/search/urls?q=http` (admin key) → `200`, results from url-service DB (not all URLs)
- [ ] `GET http://localhost:3003/admin/search/urls` (no `?q`) → `400`
- [ ] `GET http://localhost:3002/admin/urls?q=abc` (admin key) → only rows with "abc" in slug or long_url
- [ ] `ADMIN_API_URL=http://custom.example:9999 docker compose up -d admin-ui && curl http://localhost:3004/config.js` → reflects `custom.example:9999`
- [ ] `npm run test:m6` from root → all tests green against running stack

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| VanJS 1.5.2 → 1.6.0 introduces a breaking change in the admin-ui app | Low | Medium | VanJS changelog shows 1.6.x is backwards-compatible with 1.5.x. Test the admin-ui fully after the vendor step before committing other workstreams. |
| `ADMIN_API_URL` defaulting to `localhost:3003` breaks in production deployments where admin-service is on a different host | Low | High | The default is documented as "local dev only". Production deployments must set `ADMIN_API_URL`. The `.env.example` comment and `CLAUDE.md` note make this explicit. |
| `searchUrls(q)` with a wildcard LIKE query on large URL tables causes slow scans | Low | Medium | `LIMIT 100` caps result set. For large scale, a DB index on `slug` (already exists as UNIQUE) handles slug prefix searches efficiently; `long_url` LIKE with leading wildcard (`%foo`) will be a full scan — acceptable for a teaching prototype. Document as a future optimisation (DB full-text index). |
| `getAllUsers` mapping change breaks any code that currently reads `created_at` from the result | Low | Low | `getAllUsers` is only called by `auth-service GET /admin/users` which passes the result directly to the response. No other internal caller. |
| Vendored `vendor/van.min.js` and `vendor/htm.module.js` are not in `.dockerignore` exclusions | None | Medium | The Dockerfile does `COPY . .` with no exclusions for `vendor/`; both files are intentionally committed and must be in the image. This is correct. The `.dockerignore` already excludes `node_modules/` — no change needed. |
| Browser caches old `/config.js` response after `ADMIN_API_URL` change | Low | Low | `server.js` should not set aggressive `Cache-Control` on `/config.js`. Express defaults to no caching for dynamically-served routes — no action needed. |

---

## 7. Out of Scope for M6

| Item | Notes |
|------|-------|
| `GET /admin/users/:userId` full implementation | Needs new endpoints in auth-service and url-service. Tracked for M7. |
| DB full-text index on `long_url` for efficient search | `LIKE %q%` scans are acceptable for the prototype. Production optimisation is a scaling exercise. |
| Pagination on `GET /admin/urls` (no `?q`) | `LIMIT 1000` in `getAllUrls()` is pre-existing behaviour. Pagination is M7 scope. |
| SPA client-side search in admin-ui (URLs.js) | The existing `URLs.js` client-side filter across already-fetched rows is fine. `/admin/search/urls` is the server-side companion; both can coexist. |
| Admin-ui CSS / UX improvements | Out of scope — visual polish is not the goal of this milestone. |
| VanX or other VanJS extensions | Not used in the current admin-ui; no reason to introduce them in M6. |
| Nginx / reverse-proxy container | Rejected in favour of the simpler `/config.js` approach for runtime config. |
