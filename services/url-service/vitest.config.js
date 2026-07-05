import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      DB_PASSWORD: 'test',
      SERVICE_TOKEN: 'mock-service-token',
      URL_SERVICE_TOKEN: 'mock-url-service-token',
      ADMIN_SERVICE_TOKEN: 'mock-admin-service-token',
      REDIRECT_SERVICE_TOKEN: 'mock-redirect-service-token',
      LOG_LEVEL: 'silent',
    }
  },
});
