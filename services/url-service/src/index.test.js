import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('./db.js', () => ({
  createUrl:        vi.fn(),
  getUrlBySlug:     vi.fn(),
  getUserUrls:      vi.fn(),
  deleteUrl:        vi.fn(),
  updateUrl:        vi.fn(),
  updateClickCount: vi.fn(),
  getAllUrls:        vi.fn(),
  searchUrls:       vi.fn(),
  getUrlStats:      vi.fn(),
  pool:             { execute: vi.fn() },
  checkHealth:      vi.fn(),
}));

import { getUrlBySlug, deleteUrl } from './db.js';
import { app } from './index.js';

function mockValidApiKey(userId = 1, role = 'user') {
  vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ userId, role, isAdmin: role === 'admin' }),
  });
}

describe('url-service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /urls', () => {
    it('returns 401 when no API key is provided', async () => {
      const res = await request(app)
        .post('/urls')
        .send({ url: 'https://example.com' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when url field is missing', async () => {
      mockValidApiKey();
      const res = await request(app)
        .post('/urls')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/URL required/i);
    });

    it('returns 400 for an invalid URL format', async () => {
      mockValidApiKey();
      const res = await request(app)
        .post('/urls')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32))
        .send({ url: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid URL format/i);
    });

    it('returns 400 for non-http/https protocols', async () => {
      mockValidApiKey();
      const res = await request(app)
        .post('/urls')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32))
        .send({ url: 'ftp://example.com/file' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Only http and https/i);
    });

    it('returns 400 for an invalid custom slug', async () => {
      mockValidApiKey();
      const res = await request(app)
        .post('/urls')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32))
        .send({ url: 'https://example.com', customSlug: 'invalid slug!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid slug/i);
    });

    it('returns 409 when the custom slug is already taken', async () => {
      mockValidApiKey();
      getUrlBySlug.mockResolvedValueOnce({ id: 1, slug: 'taken', long_url: 'https://x.com' });
      const res = await request(app)
        .post('/urls')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32))
        .send({ url: 'https://example.com', customSlug: 'taken' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in use/i);
    });
  });

  describe('DELETE /urls/:slug', () => {
    it('returns 401 when no API key is provided', async () => {
      const res = await request(app).delete('/urls/some-slug');
      expect(res.status).toBe(401);
    });

    it('returns 404 when the slug does not exist', async () => {
      mockValidApiKey(1);
      getUrlBySlug.mockResolvedValueOnce(null);
      const res = await request(app)
        .delete('/urls/nonexistent')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32));
      expect(res.status).toBe(404);
    });

    it('returns 403 when a non-owner tries to delete', async () => {
      mockValidApiKey(2);
      getUrlBySlug.mockResolvedValueOnce({ id: 1, slug: 'test', user_id: 1 });
      const res = await request(app)
        .delete('/urls/test')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32));
      expect(res.status).toBe(403);
    });

    it('returns 200 when the owner deletes their URL', async () => {
      mockValidApiKey(1);
      getUrlBySlug.mockResolvedValueOnce({ id: 1, slug: 'mine', user_id: 1 });
      deleteUrl.mockResolvedValueOnce({ id: 1 });
      const res = await request(app)
        .delete('/urls/mine')
        .set('X-API-Key', 'msh_' + 'a'.repeat(32));
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('mine');
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
      expect(res.text).toContain('/urls');
      expect(res.text).toContain('/urls/{slug}');
      expect(res.text).toContain('/admin/urls');
      expect(res.text).toContain('/internal/admin/stats');
    });
  });
});
