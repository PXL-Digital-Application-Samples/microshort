import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, createShortUrl, resetDb } from './helpers.js';

describe('Happy Path', () => {
  beforeAll(() => {
    resetDb();
  });
  it('should complete the registered user flow with custom URL and redirect', async () => {
    const email = uniqueEmail('happy');
    const regRes = await register(email);
    expect(regRes.status).toBe(201);
    expect(regRes.token).toBeDefined();

    const keyRes = await createApiKey(regRes.token, 'happy-key');
    expect(keyRes.status).toBe(201);
    expect(keyRes.apiKey).toMatch(/^msh_/);

    const url = 'https://example.com';
    const shortenRes = await createShortUrl(keyRes.apiKey, url);
    expect(shortenRes.status).toBe(201);
    expect(shortenRes.shortUrl).toBeDefined();
    expect(shortenRes.slug).toBeDefined();

    const redirectRes = await fetch(`${BASE.redirect}/${shortenRes.slug}`, { redirect: 'manual' });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get('location')).toBe(url);
    expect(redirectRes.headers.get('cache-control')).toBe('no-store');

    const listRes = await fetch(`${BASE.urls}/urls`, {
      headers: { 'x-api-key': keyRes.apiKey }
    });
    expect(listRes.status).toBe(200);
    const { urls } = await listRes.json();
    expect(urls.find(u => u.slug === shortenRes.slug)).toBeDefined();
  });
});