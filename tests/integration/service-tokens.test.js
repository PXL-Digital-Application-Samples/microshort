import { describe, it, expect } from 'vitest';
import { BASE } from './helpers.js';

describe('M12 — Per-Service Tokens Security', () => {
  // Use the default dev tokens configured in compose.yml/env fallbacks
  const adminToken = process.env.ADMIN_SERVICE_TOKEN || 'dev-admin-token';
  const urlToken = process.env.URL_SERVICE_TOKEN || 'dev-url-token';
  const redirectToken = process.env.REDIRECT_SERVICE_TOKEN || 'dev-redirect-token';

  describe('auth-service internal stats', () => {
    it('accepts correct ADMIN_SERVICE_TOKEN', async () => {
      const res = await fetch(`${BASE.auth}/internal/admin/stats`, {
        headers: { 'X-Service-Token': adminToken }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('totalUsers');
    });

    it('rejects wrong token with 401', async () => {
      const res = await fetch(`${BASE.auth}/internal/admin/stats`, {
        headers: { 'X-Service-Token': 'wrong-token' }
      });
      expect(res.status).toBe(401);
    });
  });

  describe('url-service internal stats', () => {
    it('accepts correct ADMIN_SERVICE_TOKEN', async () => {
      const res = await fetch(`${BASE.urls}/internal/admin/stats`, {
        headers: { 'X-Service-Token': adminToken }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('totalUrls');
    });

    it('rejects wrong token with 401', async () => {
      const res = await fetch(`${BASE.urls}/internal/admin/stats`, {
        headers: { 'X-Service-Token': 'wrong-token' }
      });
      expect(res.status).toBe(401);
    });
  });

  describe('analytics-service ingestion', () => {
    it('accepts REDIRECT_SERVICE_TOKEN', async () => {
      const res = await fetch(`${BASE.analytics}/events:batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': redirectToken
        },
        body: JSON.stringify([])
      });
      // Accept returns 202 accepted (empty batch might return 202 or 400 depending on validation, but let's check code or send valid empty batch)
      expect([202, 400]).toContain(res.status); // 400 is schema invalid, 401 is unauthorized
    });

    it('accepts URL_SERVICE_TOKEN', async () => {
      const res = await fetch(`${BASE.analytics}/events:batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': urlToken
        },
        body: JSON.stringify([])
      });
      expect([202, 400]).toContain(res.status);
    });

    it('rejects wrong token with 401', async () => {
      const res = await fetch(`${BASE.analytics}/events:batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': 'wrong-token'
        },
        body: JSON.stringify([])
      });
      expect(res.status).toBe(401);
    });
  });

  describe('analytics-service stats query', () => {
    it('accepts ADMIN_SERVICE_TOKEN', async () => {
      const res = await fetch(`${BASE.analytics}/stats/overview`, {
        headers: { 'X-Service-Token': adminToken }
      });
      expect(res.status).toBe(200);
    });

    it('rejects wrong token with 401', async () => {
      const res = await fetch(`${BASE.analytics}/stats/overview`, {
        headers: { 'X-Service-Token': 'wrong-token' }
      });
      expect(res.status).toBe(401);
    });
  });
});
