import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from './index.js';

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
    // First fetch for key validation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ isAdmin: true, userId: 1, role: 'admin' })
    });
    // Second fetch to url-service for admin urls
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
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
      ok: true,
      status: 200,
      json: async () => ({ isAdmin: false, userId: 2, role: 'user' })
    });

    const res = await request(app)
      .get('/admin/urls')
      .set('X-API-Key', 'mock-user-key');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admin access required/i);
  });
});
