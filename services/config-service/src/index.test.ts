import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app, { __resetConfigCache } from './server';

beforeEach(() => {
  __resetConfigCache();
});

describe('ConfigService', () => {
  it('GET /config/domain should return domain', async () => {
    const response = await request(app).get('/config/domain');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('domain');
    expect(typeof response.body.domain).toBe('string');
  });

  it('PUT /config/domain should update domain', async () => {
    const newDomain = 'https://test.example';
    const response = await request(app)
      .put('/config/domain')
      .set('X-Service-Token', 'test-write-token')
      .send({ domain: newDomain });

    expect(response.status).toBe(200);
    expect(response.body.domain).toBe(newDomain);

    const getResponse = await request(app).get('/config/domain');
    expect(getResponse.body.domain).toBe(newDomain);
  });

  it('PUT /config/domain should reject a missing token', async () => {
    const response = await request(app)
      .put('/config/domain')
      .send({ domain: 'https://evil.test' });
    expect(response.status).toBe(401);
  });

  it('PUT /config/domain should reject a wrong token', async () => {
    const response = await request(app)
      .put('/config/domain')
      .set('X-Service-Token', 'wrong-token')
      .send({ domain: 'https://evil.test' });
    expect(response.status).toBe(401);
  });

  it('PUT /config/domain should reject http:// domains in production environment but allow them in test environment', async () => {
    // 1. In test environment, it should allow http:// domains
    const testResponse = await request(app)
      .put('/config/domain')
      .set('X-Service-Token', 'test-write-token')
      .send({ domain: 'http://insecure.example' });
    expect(testResponse.status).toBe(200);

    // 2. In production environment, it should reject http:// domains
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const prodResponse = await request(app)
        .put('/config/domain')
        .set('X-Service-Token', 'test-write-token')
        .send({ domain: 'http://insecure.example' });
      expect(prodResponse.status).toBe(400);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('__resetConfigCache should not reset domain in production mode', async () => {
    const customDomain = 'https://custom.example';
    await request(app)
      .put('/config/domain')
      .set('X-Service-Token', 'test-write-token')
      .send({ domain: customDomain });

    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      __resetConfigCache();

      const response = await request(app).get('/config/domain');
      expect(response.body.domain).toBe(customDomain);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
