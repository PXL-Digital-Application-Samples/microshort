import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, register, createApiKey, createShortUrl, resetDb, uniqueEmail } from './helpers.js';

describe('M7 — Missing endpoint coverage', () => {

  describe('DELETE /urls/:slug', () => {
    let ownerKey, otherKey, slug;

    beforeAll(async () => {
      resetDb();
      const owner = await register(uniqueEmail('del-owner'));
      const ownerKeyRes = await createApiKey(owner.token, 'owner-key');
      ownerKey = ownerKeyRes.apiKey;

      const other = await register(uniqueEmail('del-other'));
      const otherKeyRes = await createApiKey(other.token, 'other-key');
      otherKey = otherKeyRes.apiKey;

      const created = await createShortUrl(ownerKey, 'https://example.com/to-delete');
      slug = created.slug;
    });

    it('returns 403 when a non-owner tries to delete', async () => {
      const res = await fetch(`${BASE.urls}/urls/${slug}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': otherKey },
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 for a nonexistent slug', async () => {
      const res = await fetch(`${BASE.urls}/urls/nonexistent-slug-xyz-999`, {
        method: 'DELETE',
        headers: { 'X-API-Key': ownerKey },
      });
      expect(res.status).toBe(404);
    });

    it('owner deletes their URL successfully', async () => {
      const res = await fetch(`${BASE.urls}/urls/${slug}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': ownerKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slug).toBe(slug);
    });

    it('deleted URL returns 404 on redirect', async () => {
      const res = await fetch(`${BASE.redirect}/${slug}`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    });
  });

  describe('Redirect 404 for missing slug', () => {
    it('returns 404 for a slug that does not exist', async () => {
      const res = await fetch(`${BASE.redirect}/slug-that-does-not-exist-xyz`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /urls — custom slug', () => {
    let apiKey;

    beforeAll(async () => {
      resetDb();
      const user = await register(uniqueEmail('custom-slug'));
      const keyRes = await createApiKey(user.token, 'custom-slug-key');
      apiKey = keyRes.apiKey;
    });

    it('creates a URL with the given custom slug', async () => {
      const res = await fetch(`${BASE.urls}/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ url: 'https://example.com/custom', customSlug: 'my-custom' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.slug).toBe('my-custom');
    });

    it('returns 409 when the same custom slug is used again', async () => {
      const res = await fetch(`${BASE.urls}/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ url: 'https://example.com/other', customSlug: 'my-custom' }),
      });
      expect(res.status).toBe(409);
    });

    it('custom slug resolves via the redirect service', async () => {
      const res = await fetch(`${BASE.redirect}/my-custom`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.com/custom');
    });
  });

  describe('GET /auth/me', () => {
    it('returns the authenticated user profile', async () => {
      const email = uniqueEmail('me');
      const reg = await register(email);

      const res = await fetch(`${BASE.auth}/auth/me`, {
        headers: { Authorization: `Bearer ${reg.token}` },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.email).toBe(email);
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('role');
      expect(data).toHaveProperty('createdAt');
    });

    it('returns 401 without a token', async () => {
      const res = await fetch(`${BASE.auth}/auth/me`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/health/services', () => {
    let adminKey;

    beforeAll(async () => {
      resetDb();
      const admin = await register(uniqueEmail('admin-health'));
      const keyRes = await createApiKey(admin.token, 'admin-health-key');
      adminKey = keyRes.apiKey;
    });

    it('returns service health summary for an admin user', async () => {
      const res = await fetch(`${BASE.admin}/admin/health/services`, {
        headers: { 'X-API-Key': adminKey },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('services');
      expect(Array.isArray(data.services)).toBe(true);
      const names = data.services.map(s => s.service);
      expect(names).toEqual(expect.arrayContaining(['auth', 'url', 'config', 'analytics']));
      data.services.forEach(s => {
        expect(s).toHaveProperty('service');
        expect(s).toHaveProperty('status');
      });
    });

    it('returns 401 without an API key', async () => {
      const res = await fetch(`${BASE.admin}/admin/health/services`);
      expect(res.status).toBe(401);
    });
  });

});
