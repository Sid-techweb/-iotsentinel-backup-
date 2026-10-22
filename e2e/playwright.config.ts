import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real UI against a real API, PostgreSQL (+pgvector) and Redis.
 * They use their OWN database (iotmonitor_e2e), Redis db 2 and data directory, on ports 4100 / 5174, so
 * they never touch your data or a running copy of the app.
 *
 * The assistant uses the labelled deterministic test provider (LLM_PROVIDER=deterministic-test) so the run
 * needs no Ollama/GPU and is reproducible. Set E2E_LIVE_LLM=1 (with Ollama running) to use the real models.
 *
 * Browser: the installed Google Chrome (no browser download). Set E2E_CHANNEL=chromium after
 * `npx playwright install chromium` to use Playwright's own build (CI does this).
 */
export const API_PORT = 4100;
export const WEB_PORT = 5174;
export const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://iot:iot@localhost:5433/iotmonitor_e2e';

export const E2E_MONGO = process.env.E2E_MONGO_URL ?? 'mongodb://iot:iot@localhost:27017/iotmonitor_e2e?authSource=admin';

const live = process.env.E2E_LIVE_LLM === '1';
const apiEnv: Record<string, string> = {
  PORT: String(API_PORT),
  DATABASE_URL: E2E_DB,
  REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/2',
  MONGO_URL: E2E_MONGO,
  SIMULATOR: 'false',
  JWT_SECRET: 'e2e-secret-not-for-production',
  RATE_LIMIT: 'false',
  DATA_DIR: './.e2e-data',
  UPLOAD_DIR: './.e2e-data/uploads',
  NODE_ENV: 'test',
  LLM_PROVIDER: live ? 'ollama' : 'deterministic-test',
  ...(live ? { LLM_MODEL: process.env.LLM_MODEL ?? 'phi4-mini:latest' } : {}),
  CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
};

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  webServer: [
    {
      // prepare.ts recreates the e2e database (it refuses any name without "e2e") before the API boots
      command: 'npx tsx ../e2e/prepare.ts && npx tsx src/index.ts',
      cwd: '../backend',
      env: apiEnv,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: '../frontend',
      env: { API_URL: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
