import { defineConfig } from 'vitest/config';

const isRateLimitRun = process.argv.some(arg => arg.includes('rate-limiting'));

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    exclude: isRateLimitRun ? [] : ['tests/integration/m2/rate-limiting.test.js'],  // run separately via test:e2e:rate
    globalSetup: 'tests/integration/setup.js',
    testTimeout: 20_000, // increased timeout for sleep steps in rate-limiting
    hookTimeout: 30_000,
    pool: 'forks',  // each test file in its own process; avoids shared module state
  },
});