import { describe, it, expect } from 'vitest';
import { BASE, requireEnv } from './helpers.js';

const CONFIG_URL = BASE.config;

describe('M5 — Config-service: env-var driven domain', () => {
  it('GET /config/domain returns a valid domain', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBeTruthy();
    expect(body.domain).toMatch(/^https?:\/\//);
  });

  it('/ready includes current domain', async () => {
    const res = await fetch(`${CONFIG_URL}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBeTruthy();
  });
});

describe('M5 — Config-service: Ajv validation on PUT', () => {
  const writeToken = requireEnv('CONFIG_WRITE_TOKEN');

  it('rejects PUT with invalid domain format', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: 'not-a-uri' })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/[Vv]alidation/);
  });

  it('rejects PUT without auth token', async () => {
    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'http://example.com' })
    });
    expect(res.status).toBe(401);
  });

  it('accepts PUT with valid domain and returns ephemerality warning', async () => {
    const originalRes = await fetch(`${CONFIG_URL}/config/domain`);
    const original = await originalRes.json();

    const res = await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: 'http://test-update.example.com' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toMatch(/ephemeral/i);

    // Restore original domain
    await fetch(`${CONFIG_URL}/config/domain`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': writeToken
      },
      body: JSON.stringify({ domain: original.domain })
    });
  });
});

describe('M5 — Secrets: services handle missing required vars', () => {
  it('auth-service is running (envalid passed all required vars)', async () => {
    const res = await fetch(`${BASE.auth}/health`);
    expect(res.status).toBe(200);
  });

  it('redirect-service is running (IP_HASH_SALT and REDIRECT_SERVICE_TOKEN validated)', async () => {
    const res = await fetch(`${BASE.redirect}/health`);
    expect(res.status).toBe(200);
  });
});
