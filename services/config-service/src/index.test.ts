import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import app, { __resetConfigCache } from './server';

let tmp: string;

beforeEach(async () => {
  tmp = path.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(tmp, JSON.stringify({ domain: 'https://fixture.test' }));
  process.env.CONFIG_PATH = tmp;
  process.env.CONFIG_WRITE_TOKEN = 'test-write-token';
  __resetConfigCache();
});

afterEach(async () => {
  delete process.env.CONFIG_PATH;
  delete process.env.CONFIG_WRITE_TOKEN;
  await fs.rm(tmp, { force: true });
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
});
