import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('./db.js', () => ({
  createUser:      vi.fn(),
  findUserByEmail: vi.fn(),
  getUserById:     vi.fn(),
  createApiKey:    vi.fn(),
  validateApiKey:  vi.fn(),
  getUserApiKeys:  vi.fn(),
  revokeApiKey:    vi.fn(),
  getAllUsers:      vi.fn(),
  getAuthStats:    vi.fn(),
  checkHealth:     vi.fn(),
  sql:             null,
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash:    vi.fn().mockResolvedValue('$2a$10$mocked-hash'),
    compare: vi.fn().mockResolvedValue(true),
  }
}));

import { createUser, findUserByEmail, getUserById, validateApiKey, getAuthStats } from './db.js';
import bcrypt from 'bcryptjs';
import { app } from './index.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';

describe('auth-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('returns 400 when email is missing', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ password: 'Test-pass-123!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it('returns 400 when password is missing', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com' });
      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate email', async () => {
      createUser.mockRejectedValueOnce({ code: '23505' });
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'dup@example.com', password: 'Test-pass-123!' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/i);
    });
  });

  describe('POST /auth/login', () => {
    it('returns 400 when credentials are missing', async () => {
      const res = await request(app).post('/auth/login').send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 for an unknown email', async () => {
      findUserByEmail.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'Test-pass-123!' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid credentials/i);
    });

    it('returns 401 for a wrong password', async () => {
      findUserByEmail.mockResolvedValueOnce({
        id: 1, email: 'user@example.com', password_hash: '$2a$10$mocked', role: 'user'
      });
      bcrypt.compare.mockResolvedValueOnce(false);
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'wrong' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('returns 400 when refresh token is missing', async () => {
      const res = await request(app).post('/auth/refresh').send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for a token without type=refresh', async () => {
      const accessToken = jwt.sign({ userId: 1, email: 'x@x.com' }, JWT_SECRET);
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: accessToken });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid token type/i);
    });

    it('returns 200 with a new access token for a valid refresh token', async () => {
      getUserById.mockResolvedValueOnce({ id: 1, email: 'user@example.com', role: 'user' });
      const refreshToken = jwt.sign({ userId: 1, type: 'refresh' }, JWT_SECRET);
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
    });
  });

  describe('POST /auth/validate', () => {
    it('returns 400 when apiKey is missing', async () => {
      const res = await request(app).post('/auth/validate').send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 for an unrecognised key', async () => {
      validateApiKey.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/auth/validate')
        .send({ apiKey: 'msh_' + 'a'.repeat(32) });
      expect(res.status).toBe(401);
    });
  });

  describe('requireServiceToken (GET /internal/admin/stats)', () => {
    it('returns 401 when X-Service-Token header is missing', async () => {
      const res = await request(app).get('/internal/admin/stats');
      expect(res.status).toBe(401);
    });

    it('returns 401 for a wrong service token', async () => {
      const res = await request(app)
        .get('/internal/admin/stats')
        .set('X-Service-Token', 'wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 200 with the correct service token', async () => {
      getAuthStats.mockResolvedValueOnce({ totalUsers: 5, recentUsers: [], totalApiKeys: 3 });
      const res = await request(app)
        .get('/internal/admin/stats')
        .set('X-Service-Token', 'mock-admin-service-token');
      expect(res.status).toBe(200);
    });
  });

  describe('Swagger UI', () => {
    it('GET /docs/ serves the Swagger UI HTML', async () => {
      const res = await request(app).get('/docs/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('swagger-ui');
    });

    it('GET /docs/swagger-ui-init.js exposes the full spec', async () => {
      const res = await request(app).get('/docs/swagger-ui-init.js');
      expect(res.status).toBe(200);
      // Verify key routes from each endpoint group are in the spec
      expect(res.text).toContain('/auth/login');
      expect(res.text).toContain('/auth/register');
      expect(res.text).toContain('/auth/api-keys');
      expect(res.text).toContain('/auth/validate');
      expect(res.text).toContain('/admin/users');
      expect(res.text).toContain('/internal/admin/stats');
    });
  });
});
