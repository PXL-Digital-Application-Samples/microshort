import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, register, createApiKey, resetDb, uniqueEmail, createShortUrl } from './helpers.js';

const AUTH_URL  = BASE.auth;
const URL_URL   = BASE.urls;
const ADMIN_URL = BASE.admin;
const UI_URL    = BASE.adminUi;

let adminKey;

beforeAll(async () => {
  // Truncate users so the first registration in this suite gets the admin role.
  // Pattern mirrors m4.integration.test.js "M4 — Admin dashboard & cache".
  resetDb();
  const { token } = await register(uniqueEmail('m6admin'));
  const { apiKey } = await createApiKey(token, 'm6-admin-key');
  adminKey = apiKey;

  // Create test URLs to verify the search capabilities
  await createShortUrl(adminKey, 'https://google.com/findme-m6-test');
  await createShortUrl(adminKey, 'https://yahoo.com/other-m6-test');
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
    const res = await fetch(`${ADMIN_URL}/admin/search/urls?q=findme-m6-test`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('urls');
    expect(Array.isArray(data.urls)).toBe(true);
    expect(data.urls.length).toBe(1);
    expect(data.urls[0].longUrl).toContain('findme-m6-test');
  });

  it('url-service GET /admin/urls?q= filters by slug or long_url', async () => {
    const res = await fetch(`${URL_URL}/admin/urls?q=findme-m6-test`, {
      headers: { 'X-API-Key': adminKey }
    });
    expect(res.status).toBe(200);
    const { urls } = await res.json();
    expect(Array.isArray(urls)).toBe(true);
    expect(urls.length).toBe(1);
    urls.forEach(u => {
      const matchesSlug = u.slug.includes('findme-m6-test');
      const matchesLong = u.longUrl.toLowerCase().includes('findme-m6-test');
      expect(matchesSlug || matchesLong).toBe(true);
    });
  });
});
