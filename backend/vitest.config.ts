import { defineConfig } from 'vitest/config';
import { testEnv } from './tests/env';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: testEnv,
    // the API tests share one database, so files run one after another
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
