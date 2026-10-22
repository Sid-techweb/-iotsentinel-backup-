/** Test configuration shared by the vitest config (worker env) and the global setup (database creation). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://iot:iot@localhost:5433/iotmonitor_test';
export const TEST_MONGO_URL = process.env.TEST_MONGO_URL ?? 'mongodb://iot:iot@localhost:27017/iotmonitor_test?authSource=admin';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export const testEnv = {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  MONGO_URL: TEST_MONGO_URL,
  SIMULATOR: 'false',
  JWT_SECRET: 'test-secret-not-for-production',
  RATE_LIMIT: 'false',
  // webhook delivery is tested against a local receiver; the private-address guard is tested explicitly
  ALLOW_PRIVATE_WEBHOOKS: 'true',
  LLM_PROVIDER: 'deterministic-test',
  NODE_ENV: 'test',
};
