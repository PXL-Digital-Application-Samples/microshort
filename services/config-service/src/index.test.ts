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
  __resetConfigCache();
});

afterEach(async () => {
  delete process.env.CONFIG_PATH;
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
      .send({ domain: newDomain });

    expect(response.status).toBe(200);
    expect(response.body.domain).toBe(newDomain);

    const getResponse = await request(app).get('/config/domain');
    expect(getResponse.body.domain).toBe(newDomain);
  });
});
