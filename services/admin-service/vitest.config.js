import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    env: {
      ADMIN_SERVICE_TOKEN: 'mock-admin-token',
      CONFIG_WRITE_TOKEN: 'mock-config-token',
      SERVICE_TOKEN: 'mock-service-token',
      NODE_ENV: 'test',
    }
  },
});
