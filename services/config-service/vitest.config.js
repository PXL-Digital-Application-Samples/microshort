import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DOMAIN: 'https://fixture.test',
      CONFIG_WRITE_TOKEN: 'test-write-token'
    }
  },
});
