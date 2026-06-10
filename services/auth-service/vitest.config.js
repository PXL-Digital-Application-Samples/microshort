import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-at-least-32-chars-long',
      DB_PASSWORD: 'test',
      SERVICE_TOKEN: 'mock-service-token',
      ADMIN_SERVICE_TOKEN: 'mock-admin-service-token',
      LOG_LEVEL: 'silent',
    }
  },
});
