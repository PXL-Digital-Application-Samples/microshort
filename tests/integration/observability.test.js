import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, createShortUrl, resetDb } from './helpers.js';

// All six Node services get /ready
const SERVICES_READY = [
  { name: 'auth',      url: BASE.auth },
  { name: 'url',       url: BASE.urls },
  { name: 'redirect',  url: BASE.redirect },
  { name: 'admin',     url: BASE.admin },
  { name: 'config',    url: BASE.config },
  { name: 'admin-ui',  url: BASE.adminUi || 'http://localhost:3004' },
];

const SERVICES_METRICS = [
  { name: 'auth',     url: BASE.auth },
  { name: 'url',      url: BASE.urls },
  { name: 'redirect', url: BASE.redirect },
  { name: 'admin',    url: BASE.admin },
  { name: 'config',   url: BASE.config },
];

describe('M4 — Readiness endpoints', () => {
  for (const svc of SERVICES_READY) {
    it(`${svc.name}-service /ready returns 200`, async () => {
      const res = await fetch(`${svc.url}/ready`);
      expect(res.status).toBe(200);
      if (svc.name !== 'admin-ui') {
        const body = await res.json();
        expect(body.status).toBe('ready');
      } else {
        const body = await res.text();
        expect(body).toBe('OK');
      }
    });
  }
});

describe('M4 — Prometheus metrics', () => {
  for (const svc of SERVICES_METRICS) {
    it(`${svc.name}-service /metrics returns valid Prometheus text`, async () => {
      const res = await fetch(`${svc.url}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toMatch(/^# HELP /m);
      expect(body).toMatch(/^# TYPE /m);
    });
  }
});

describe('M4 — analytics-service Prometheus metrics', () => {
  it('analytics-service /actuator/prometheus returns Prometheus text without a token', async () => {
    const res = await fetch(`${BASE.analytics}/actuator/prometheus`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^# HELP /m);
    expect(body).toMatch(/^# TYPE /m);
  });
});

describe('M4 — X-Request-ID propagation', () => {
  it('echoes X-Request-ID header in auth-service response', async () => {
    const id = 'test-correlation-123';
    const res = await fetch(`${BASE.auth}/health`, {
      headers: { 'x-request-id': id }
    });
    expect(res.headers.get('x-request-id')).toBe(id);
  });

  it('generates X-Request-ID when absent', async () => {
    const res = await fetch(`${BASE.auth}/health`);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);  // UUID format
  });
});

describe('M4 — Admin dashboard & cache', () => {
  let adminApiKey;

  beforeAll(async () => {
    resetDb();
    // Register the first user, which automatically becomes an admin
    const email = uniqueEmail('m4admin');
    const { token } = await register(email);
    const keyRes = await createApiKey(token, 'm4-admin-key');
    adminApiKey = keyRes.apiKey;
  });

  it('returns full response when all services healthy', async () => {
    const res = await fetch(`${BASE.admin}/admin/dashboard`, {
      headers: { 'X-API-Key': adminApiKey }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBeUndefined();
    expect(body.users).not.toBeNull();
    expect(body.urls).toBeDefined();
  });

  it('dashboard cache: second call within TTL returns same response', async () => {
    const fetch1 = await (await fetch(`${BASE.admin}/admin/dashboard`, {
      headers: { 'X-API-Key': adminApiKey }
    })).json();
    const fetch2 = await (await fetch(`${BASE.admin}/admin/dashboard`, {
      headers: { 'X-API-Key': adminApiKey }
    })).json();
    expect(fetch1).toEqual(fetch2);
  });
});

describe('M4 — Redirect-service Redis cache', () => {
  it('redirect cache hit/miss metrics are non-zero after redirect', async () => {
    const email = uniqueEmail('m4cache');
    const { token } = await register(email);
    const keyRes = await createApiKey(token, 'm4-cache-key');
    const shortenRes = await createShortUrl(keyRes.apiKey, 'https://example.com/m4cache');
    expect(shortenRes.status).toBe(201);

    // First fetch: cache miss
    const res1 = await fetch(`${BASE.redirect}/${shortenRes.slug}`, { redirect: 'manual' });
    expect(res1.status).toBe(302);

    // Second fetch: cache hit
    const res2 = await fetch(`${BASE.redirect}/${shortenRes.slug}`, { redirect: 'manual' });
    expect(res2.status).toBe(302);

    // Then check metrics
    const metrics = await (await fetch(`${BASE.redirect}/metrics`)).text();
    expect(metrics).toMatch(/microshort_redirect_cache_misses_total/);
    expect(metrics).toMatch(/microshort_redirect_cache_hits_total/);
  });
});
