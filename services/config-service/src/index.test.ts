import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';

// Import your actual app file logic as a function if modularized.
// Or recreate here minimally for testing if not.

import app from './server'; // Assuming you modularize the Express app into server.ts

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
