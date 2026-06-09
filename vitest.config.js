import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    exclude: ['tests/integration/m2/rate-limiting.test.js'],  // run separately via test:e2e:rate
    globalSetup: 'tests/integration/setup.js',
    testTimeout: 10_000,
    hookTimeout: 30_000,
    pool: 'forks',  // each test file in its own process; avoids shared module state
  },
});