import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app, __resetDashboardCache } from './index.js';

describe('AdminService Endpoints', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  it('GET /admin/urls requires X-API-Key', async () => {
    const res = await request(app).get('/admin/urls');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key required/i);
  });

  it('GET /admin/urls validates admin role and returns urls list', async () => {
    const mockFetch = vi.spyOn(global, 'fetch');
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ isAdmin: true, userId: 1, role: 'admin' })
    });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ urls: [{ id: 1, slug: 'test' }] })
    });

    const res = await request(app)
      .get('/admin/urls')
      .set('X-API-Key', 'mock-admin-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ urls: [{ id: 1, slug: 'test' }] });
  });

  it('GET /admin/urls rejects non-admin users', async () => {
    const mockFetch = vi.spyOn(global, 'fetch');
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ isAdmin: false, userId: 2, role: 'user' })
    });

    const res = await request(app)
      .get('/admin/urls')
      .set('X-API-Key', 'mock-user-key');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admin access required/i);
  });

  describe('validateAdminKey', () => {
    it('returns 503 when auth service is unavailable', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('connection refused'));
      const res = await request(app)
        .get('/admin/urls')
        .set('X-API-Key', 'mock-key');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/Authentication service unavailable/i);
    });
  });

  describe('GET /admin/dashboard', () => {
    beforeEach(() => {
      __resetDashboardCache();
    });

    it('returns a full dashboard response when all services are up', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalUsers: 10, recentUsers: [], totalApiKeys: 5 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalUrls: 20, recentUrls: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalClicks: 100 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => [] });

      const res = await request(app)
        .get('/admin/dashboard')
        .set('X-API-Key', 'admin-key');

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('degraded');
      expect(res.body.users.total).toBe(10);
      expect(res.body.urls.total).toBe(20);
    });

    it('includes degraded list when upstream services fail', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) })
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })   // auth stats fail
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalUrls: 5, recentUrls: [] }) })
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })   // analytics overview fail
        .mockResolvedValueOnce({ ok: true, json: async () => [] });

      const res = await request(app)
        .get('/admin/dashboard')
        .set('X-API-Key', 'admin-key');

      expect(res.status).toBe(200);
      expect(res.body.degraded).toEqual(expect.arrayContaining(['auth', 'analytics']));
      expect(res.body.users).toBeNull();
    });

    it('serves subsequent requests from cache within the TTL', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      // First request: 1 auth validate + 4 upstream = 5 calls
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalUsers: 3, recentUsers: [], totalApiKeys: 1 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalUrls: 7, recentUrls: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ totalClicks: 50 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => [] });
      // Second request within TTL: 1 auth validate only (cache hit)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) });

      await request(app).get('/admin/dashboard').set('X-API-Key', 'admin-key');
      const res2 = await request(app).get('/admin/dashboard').set('X-API-Key', 'admin-key');

      expect(res2.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(6);
      expect(res2.body).not.toHaveProperty('degraded');
    });
  });

  describe('PUT /admin/config', () => {
    it('returns 400 when domain is empty', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true, json: async () => ({ isAdmin: true })
      });
      const res = await request(app)
        .put('/admin/config')
        .set('X-API-Key', 'admin-key')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Domain required/i);
    });
  });

  describe('GET /admin/search/urls', () => {
    it('returns 400 when the query parameter is missing', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true, json: async () => ({ isAdmin: true })
      });
      const res = await request(app)
        .get('/admin/search/urls')
        .set('X-API-Key', 'admin-key');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Search query required/i);
    });
  });

  describe('GET /admin/health/services', () => {
    it('returns service health summary with correct structure', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) });
      ['auth', 'url', 'config', 'analytics'].forEach(() => {
        mockFetch.mockResolvedValueOnce({ ok: true });
      });

      const res = await request(app)
        .get('/admin/health/services')
        .set('X-API-Key', 'admin-key');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('services');
      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services).toHaveLength(4);

      const names = res.body.services.map(s => s.service);
      expect(names).toEqual(expect.arrayContaining(['auth', 'url', 'config', 'analytics']));

      res.body.services.forEach(s => {
        expect(s).toHaveProperty('service');
        expect(s).toHaveProperty('status');
      });
    });

    it('marks an unreachable service as unreachable', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) });
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));     // auth unreachable
      mockFetch.mockResolvedValueOnce({ ok: true });
      mockFetch.mockResolvedValueOnce({ ok: true });
      mockFetch.mockResolvedValueOnce({ ok: true });

      const res = await request(app)
        .get('/admin/health/services')
        .set('X-API-Key', 'admin-key');

      expect(res.status).toBe(200);
      const authStatus = res.body.services.find(s => s.service === 'auth');
      expect(authStatus.status).toBe('unreachable');
    });

    it('includes a numeric responseTime (e.g. "12ms") for reachable services and omits it for unreachable ones', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isAdmin: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true });   // auth healthy
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')); // url unreachable
      mockFetch.mockResolvedValueOnce({ ok: true });   // config healthy
      mockFetch.mockResolvedValueOnce({ ok: true });   // analytics healthy

      const res = await request(app)
        .get('/admin/health/services')
        .set('X-API-Key', 'admin-key');

      expect(res.status).toBe(200);

      const reachable = res.body.services.filter(s => s.status !== 'unreachable');
      reachable.forEach(s => {
        expect(s).toHaveProperty('responseTime');
        expect(s.responseTime).toMatch(/^\d+ms$/);
        expect(s.responseTime).not.toBe('N/A');
      });

      const unreachable = res.body.services.find(s => s.service === 'url');
      expect(unreachable.status).toBe('unreachable');
      expect(unreachable).not.toHaveProperty('responseTime');
    });
  });

  describe('Swagger UI', () => {
    it('GET /docs/ serves the Swagger UI HTML', async () => {
      const res = await request(app).get('/docs/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('swagger-ui');
    });

    it('GET /docs/swagger-ui-init.js exposes the full spec', async () => {
      const res = await request(app).get('/docs/swagger-ui-init.js');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/admin/dashboard');
      expect(res.text).toContain('/admin/urls');
      expect(res.text).toContain('/admin/config');
      expect(res.text).toContain('/admin/search/urls');
      expect(res.text).toContain('/admin/health/services');
    });
  });
});
