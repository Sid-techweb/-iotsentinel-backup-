import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
const E2E_DB = process.env.DATABASE_URL ?? 'postgres://iot:iot@localhost:5433/iotmonitor_e2e';

/** Run before the API starts (see playwright.config.ts): a fresh database for every run: the e2e scenario starts from an empty installation. */
(async () => {
  const url = new URL(E2E_DB);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]*e2e[a-z0-9_]*$/.test(name)) throw new Error(`Refusing to reset "${name}": the e2e database name must contain "e2e"`);
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  fs.rmSync(path.resolve(process.cwd(), '.e2e-data'), { recursive: true, force: true });

  // empty the e2e Redis database too (db 2 - not the app's db 0, nor the unit tests' db 1)
  const { default: Redis } = await import('ioredis').catch(() => ({ default: null as any }));
  if (Redis) { const r = new Redis(process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/2'); await r.flushdb(); await r.quit(); }
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
