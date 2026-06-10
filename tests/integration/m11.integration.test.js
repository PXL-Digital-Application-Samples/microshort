import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, register, createApiKey, resetDb, uniqueEmail, createShortUrl } from './helpers.js';

describe('M11 — url-service: PUT /urls/:slug (URL Update)', () => {
  let userAKey;
  let userBKey;
  let urlRecord;

  beforeAll(async () => {
    resetDb();

    // Register User A and get key
    const userA = await register(uniqueEmail('userA'));
    const keyA = await createApiKey(userA.token, 'key-a');
    userAKey = keyA.apiKey;

    // Register User B and get key
    const userB = await register(uniqueEmail('userB'));
    const keyB = await createApiKey(userB.token, 'key-b');
    userBKey = keyB.apiKey;

    // Create a short URL for User A
    urlRecord = await createShortUrl(userAKey, 'https://example.com/initial-destination');
    expect(urlRecord.slug).toBeDefined();
  });

  it('updates the long URL when requested by the owner', async () => {
    const res = await fetch(`${BASE.urls}/urls/${urlRecord.slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userAKey
      },
      body: JSON.stringify({ url: 'https://example.com/updated-by-owner' })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.longUrl).toBe('https://example.com/updated-by-owner');

    // Verify redirect service resolves to new URL
    // redirect-service has rate limiting so we perform one call
    const redirectRes = await fetch(`${BASE.redirect}/${urlRecord.slug}`, {
      redirect: 'manual'
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get('location')).toBe('https://example.com/updated-by-owner');
  });

  it('denies updates if the API key belongs to a different user', async () => {
    const res = await fetch(`${BASE.urls}/urls/${urlRecord.slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userBKey
      },
      body: JSON.stringify({ url: 'https://example.com/unauthorized-update' })
    });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/Forbidden/i);
  });

  it('denies updates without API key', async () => {
    const res = await fetch(`${BASE.urls}/urls/${urlRecord.slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: 'https://example.com/no-key-update' })
    });

    expect(res.status).toBe(401);
  });

  it('denies updates with invalid URL format', async () => {
    const res = await fetch(`${BASE.urls}/urls/${urlRecord.slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userAKey
      },
      body: JSON.stringify({ url: 'not-a-valid-url' })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid URL format/i);
  });

  it('denies updates with non-http/https URL schemes', async () => {
    const res = await fetch(`${BASE.urls}/urls/${urlRecord.slug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': userAKey
      },
      body: JSON.stringify({ url: 'ftp://example.com/ftp-destination' })
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Only http and https/i);
  });
});
