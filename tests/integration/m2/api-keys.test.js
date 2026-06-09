import { describe, it, expect } from 'vitest';
import { BASE, uniqueEmail, register, createApiKey } from '../helpers.js';

describe('API Keys', () => {
  it('should support create, hide, validate and revoke flow', async () => {
    const email = uniqueEmail('keytest');
    const regRes = await register(email);
    expect(regRes.status).toBe(200);

    // key returned once
    const keyRes = await createApiKey(regRes.token, 'key-to-revoke');
    expect(keyRes.status).toBe(200);
    const rawKey = keyRes.apiKey;
    const keyId = keyRes.keyId;
    expect(rawKey).toMatch(/^msh_/);

    // key not in listing
    const listRes = await fetch(`${BASE.auth}/auth/api-keys`, {
      headers: { Authorization: `Bearer ${regRes.token}` }
    });
    expect(listRes.status).toBe(200);
    const { keys } = await listRes.json();
    const listedKey = keys.find(k => k.id === keyId);
    expect(listedKey).toBeDefined();
    expect(listedKey.key).toBeUndefined();
    expect(listedKey.apiKey).toBeUndefined();

    // valid key validates
    const valRes = await fetch(`${BASE.auth}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: rawKey })
    });
    expect(valRes.status).toBe(200);
    const valData = await valRes.json();
    expect(valData.valid).toBe(true);
    expect(valData.userId).toBe(regRes.userId);
    expect(valData.role).toBeDefined();
    expect(valData.isAdmin).toBeDefined();

    // corrupted key rejected
    const corruptedKey = rawKey.replace('msh_', 'msh_corrupt');
    const valCorRes = await fetch(`${BASE.auth}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: corruptedKey })
    });
    expect(valCorRes.status).toBe(401);

    // revoke
    const revRes = await fetch(`${BASE.auth}/auth/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${regRes.token}` }
    });
    expect(revRes.status).toBe(200);

    // validate after revoke
    const valAfterRevRes = await fetch(`${BASE.auth}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: rawKey })
    });
    expect(valAfterRevRes.status).toBe(401);

    // double-revoke
    const rev2Res = await fetch(`${BASE.auth}/auth/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${regRes.token}` }
    });
    expect(rev2Res.status).toBe(404);

    // revoked key hidden from active list
    const list2Res = await fetch(`${BASE.auth}/auth/api-keys`, {
      headers: { Authorization: `Bearer ${regRes.token}` }
    });
    expect(list2Res.status).toBe(200);
    const { keys: keys2 } = await list2Res.json();
    expect(keys2.find(k => k.id === keyId)).toBeUndefined();
  });
});