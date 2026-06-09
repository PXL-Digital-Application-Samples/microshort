import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, resetDb } from '../helpers.js';

describe('Config Authentication', () => {
  beforeAll(() => {
    resetDb();
  });
  let originalDomain = 'http://localhost:3004';

  it('should protect domain config write operations', async () => {
    // 1. PUT without token -> 401
    const noTokenRes = await fetch(`${BASE.config}/config/domain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://evil.test' })
    });
    expect(noTokenRes.status).toBe(401);

    // 2. PUT with wrong token -> 401
    const wrongTokenRes = await fetch(`${BASE.config}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': 'wrong-token'
      },
      body: JSON.stringify({ domain: 'https://evil.test' })
    });
    expect(wrongTokenRes.status).toBe(401);

    // 3. admin key via admin-service -> PUT /admin/config -> 200
    // We register an admin user (first user).
    const adminEmail = uniqueEmail('configAdmin');
    const adminReg = await register(adminEmail);
    expect(adminReg.status).toBe(200);

    const adminKey = await createApiKey(adminReg.token, 'admin-config-key');
    expect(adminKey.status).toBe(200);

    // Get original first to restore
    const getRes = await fetch(`${BASE.config}/config/domain`);
    if (getRes.ok) {
      const getBody = await getRes.json();
      originalDomain = getBody.domain;
    }

    const newDomain = 'https://cool-new-domain.com';
    const putRes = await fetch(`${BASE.admin}/admin/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': adminKey.apiKey
      },
      body: JSON.stringify({ domain: newDomain })
    });
    expect(putRes.status).toBe(200);

    // GET /config/domain reflects new value
    const getNewRes = await fetch(`${BASE.config}/config/domain`);
    expect(getNewRes.status).toBe(200);
    const getNewBody = await getNewRes.json();
    expect(getNewBody.domain).toBe(newDomain);

    // Clean up: restore original domain via admin-service
    await fetch(`${BASE.admin}/admin/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': adminKey.apiKey
      },
      body: JSON.stringify({ domain: originalDomain })
    });
  });
});