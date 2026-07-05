import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, createShortUrl, postEvents, getSlugCounts, resetDb, requireEnv } from '../helpers.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

describe('Analytics service', () => {
  beforeAll(() => {
    resetDb();
  });
  it('liveness probe returns 200', async () => {
    const res = await fetch(`${BASE.analytics}/actuator/health/liveness`);
    expect(res.status).toBe(200);
  });

  it('readiness probe returns 200 (ClickHouse reachable)', async () => {
    const res = await fetch(`${BASE.analytics}/actuator/health/readiness`);
    expect(res.status).toBe(200);
  });

  it('POST /events:batch without token → 401', async () => {
    const res = await fetch(`${BASE.analytics}/events:batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([])
    });
    expect(res.status).toBe(401);
  });

  it('POST /events:batch with token → 202', async () => {
    const { status } = await postEvents([{
      slug: 'test-slug',
      ts: new Date().toISOString(),
      referrer: '',
      userAgent: 'test-agent',
      ipHash: 'a'.repeat(64)
    }]);
    expect(status).toBe(202);
  });

  it('GET /stats/counts returns zero for unknown slug', async () => {
    const { status, ...counts } = await getSlugCounts(['unknown-slug-xyz']);
    expect(status).toBe(200);
    expect(counts['unknown-slug-xyz']).toBe(0);
  });

  it('click event is recorded and queryable', async () => {
    const slug = `test-${Date.now()}`;
    await postEvents([{
      slug,
      ts: new Date().toISOString(),
      referrer: 'https://example.com',
      userAgent: 'Mozilla/5.0',
      ipHash: 'b'.repeat(64)
    }]);

    // ClickHouse materialized views update asynchronously — allow up to 5 s
    let counts = {};
    for (let i = 0; i < 10; i++) {
      await wait(500);
      const result = await getSlugCounts([slug]);
      if (result[slug] > 0) { counts = result; break; }
    }
    expect(counts[slug]).toBeGreaterThanOrEqual(1);
  });

  it('redirect returns 302 with Cache-Control: no-store', async () => {
    const email = uniqueEmail('m3redir');
    const { token } = await register(email);
    const { apiKey } = await (async () => {
      const r = await fetch(`${BASE.auth}/auth/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'm3-key' })
      });
      return r.json();
    })();
    const { slug } = await createShortUrl(apiKey, 'https://example.com/m3');
    const res = await fetch(`${BASE.redirect}/${slug}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /stats/overview returns expected shape', async () => {
    const res = await fetch(`${BASE.analytics}/stats/overview`, {
      headers: { 'X-Service-Token': requireEnv('ADMIN_SERVICE_TOKEN') }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalClicks');
    expect(body).toHaveProperty('last7DayClicks');
  });
});
