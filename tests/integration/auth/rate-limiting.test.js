import { describe, it, expect } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, createShortUrl } from '../helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Rate Limiting', () => {
  it('should rate limit authentication requests and reset after the window expires', async () => {
    const email = uniqueEmail('ratelimit-auth');
    const password = 'Test-pass-123!';

    // Register the user (consumes 1 request on auth service authLimiter)
    const regRes = await register(email, password);
    expect(regRes.status).toBe(200);

    // Wait 5.5 seconds to let the rate limit window reset completely
    await sleep(5500);

    // Now we have a clean window. Limit is 3.
    // 1st login attempt
    const login1 = await fetch(`${BASE.auth}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login1.status).toBe(200);

    // 2nd login attempt
    const login2 = await fetch(`${BASE.auth}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login2.status).toBe(200);

    // 3rd login attempt
    const login3 = await fetch(`${BASE.auth}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login3.status).toBe(200);

    // 4th login attempt should trigger rate limiting (429)
    const login4 = await fetch(`${BASE.auth}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login4.status).toBe(429);

    // Verify draft-6 rate limit headers
    expect(login4.headers.get('ratelimit-limit')).toBe('3');
    expect(login4.headers.get('ratelimit-remaining')).toBe('0');
    expect(login4.headers.get('ratelimit-reset')).toBeDefined();
    
    const body4 = await login4.json();
    expect(body4.error).toBe('Too many attempts, please try again later');

    // Wait 5.5 seconds for the window to reset again
    await sleep(5500);

    // Next login attempt should succeed now that the window has reset
    const login5 = await fetch(`${BASE.auth}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login5.status).toBe(200);
  });

  it('should rate limit URL creation requests and reset after the window expires', async () => {
    const email = uniqueEmail('ratelimit-urls');
    const password = 'Test-pass-123!';

    // Register and get API key (these are on auth-service, so they don't count towards url-service rate limiting)
    const regRes = await register(email, password);
    expect(regRes.status).toBe(200);

    const keyRes = await createApiKey(regRes.token, 'rl-key');
    expect(keyRes.status).toBe(200);
    const apiKey = keyRes.apiKey;

    // Now make URL creations on url-service. Limit is 5.
    // 1st request
    const url1 = await createShortUrl(apiKey, 'https://example.com/1');
    expect(url1.status).toBe(201);

    // 2nd request
    const url2 = await createShortUrl(apiKey, 'https://example.com/2');
    expect(url2.status).toBe(201);

    // 3rd request
    const url3 = await createShortUrl(apiKey, 'https://example.com/3');
    expect(url3.status).toBe(201);

    // 4th request
    const url4 = await createShortUrl(apiKey, 'https://example.com/4');
    expect(url4.status).toBe(201);

    // 5th request
    const url5 = await createShortUrl(apiKey, 'https://example.com/5');
    expect(url5.status).toBe(201);

    // 6th request should trigger rate limiting (429)
    const url6Res = await fetch(`${BASE.urls}/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ url: 'https://example.com/6' }),
    });
    expect(url6Res.status).toBe(429);

    // Verify draft-6 rate limit headers
    expect(url6Res.headers.get('ratelimit-limit')).toBe('5');
    expect(url6Res.headers.get('ratelimit-remaining')).toBe('0');
    expect(url6Res.headers.get('ratelimit-reset')).toBeDefined();

    const body6 = await url6Res.json();
    expect(body6.error).toBe('Too many requests, please try again later');

    // Wait 5.5 seconds for the window to reset
    await sleep(5500);

    // Next URL creation request should succeed now that the window has reset
    const url7 = await createShortUrl(apiKey, 'https://example.com/7');
    expect(url7.status).toBe(201);
  });
});
