import { afterAll } from 'vitest';
import { pool } from '../src/db';
import { redis } from '../src/redis';

// close the shared connections so each test file exits cleanly
afterAll(async () => {
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
});
