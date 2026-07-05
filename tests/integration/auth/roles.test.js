import { describe, it, expect, beforeAll } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey, resetDb } from '../helpers.js';

describe('Roles', () => {
  beforeAll(() => {
    resetDb();
  });
  it('should assign admin or user based on registration order', async () => {
    // This test assumes a fresh DB. The first registered user is admin.
    const firstRoleEmail = uniqueEmail('firstAdmin');
    const firstReg = await register(firstRoleEmail);
    expect(firstReg.status).toBe(201);

    const firstKey = await createApiKey(firstReg.token, 'admin-key');
    expect(firstKey.status).toBe(201);

    const valFirst = await fetch(`${BASE.auth}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: firstKey.apiKey })
    });
    expect(valFirst.status).toBe(200);
    const valFirstData = await valFirst.json();
    expect(valFirstData.role).toBe('admin');
    expect(valFirstData.isAdmin).toBe(true);

    // Second user is regular
    const secondRoleEmail = uniqueEmail('secondUser');
    const secondReg = await register(secondRoleEmail);
    expect(secondReg.status).toBe(201);

    const secondKey = await createApiKey(secondReg.token, 'user-key');
    expect(secondKey.status).toBe(201);

    const valSecond = await fetch(`${BASE.auth}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: secondKey.apiKey })
    });
    expect(valSecond.status).toBe(200);
    const valSecondData = await valSecond.json();
    expect(valSecondData.role).toBe('user');
    expect(valSecondData.isAdmin).toBe(false);

    // non-admin key blocked on /admin/users
    const blockedRes = await fetch(`${BASE.admin}/admin/users`, {
      headers: { 'x-api-key': secondKey.apiKey }
    });
    expect(blockedRes.status).toBe(403);

    // admin key allowed on /admin/users
    const allowedRes = await fetch(`${BASE.admin}/admin/users`, {
      headers: { 'x-api-key': firstKey.apiKey }
    });
    expect(allowedRes.status).toBe(200);

    // admin dashboard GET /admin/dashboard returns 200 with admin key
    const dashboardRes = await fetch(`${BASE.admin}/admin/dashboard`, {
      headers: { 'x-api-key': firstKey.apiKey }
    });
    expect(dashboardRes.status).toBe(200);
    const dashData = await dashboardRes.json();
    expect(dashData.users).toBeDefined();
    expect(dashData.urls).toBeDefined();
  });
});