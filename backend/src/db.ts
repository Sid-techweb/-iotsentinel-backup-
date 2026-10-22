import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool, types } from 'pg';
import { config } from './config';
import { camelize } from './util';

// bigint columns (BIGSERIAL ids, counts) come back as numbers rather than strings; they stay far below 2^53
types.setTypeParser(20, (v) => Number(v));

export const pool = new Pool({ connectionString: config.databaseUrl });

/** Run a query and return camelCased rows. */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return camelize<T[]>(res.rows);
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

/** Optional capabilities that depend on what the database offers. */
export const features = { knowledgeBase: false };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 727274; // arbitrary constant: only one process may migrate at a time

export interface MigrationResult { applied: string[]; skipped: string[] }

/**
 * Versioned SQL migrations (backend/migrations/NNN_name.sql), applied in order and recorded in
 * `schema_migrations`. A file starting with `-- requires: <extension>` is skipped, with a warning,
 * when that PostgreSQL extension is not installed; it is retried on the next start.
 */
export async function migrate(): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [] };
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const version = file.split('_')[0];
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(version)) {
        if (done.get(version) !== checksum) console.warn(`[migrate] ${file} changed after it was applied - create a new migration instead of editing old ones`);
        continue;
      }
      const needs = /^--\s*requires:\s*(\w+)/m.exec(sql)?.[1];
      if (needs) {
        const available = await client.query('SELECT 1 FROM pg_available_extensions WHERE name=$1', [needs]);
        if (!available.rowCount) {
          console.warn(`[migrate] skipping ${file}: PostgreSQL extension "${needs}" is not installed (knowledge base / assistant disabled)`);
          result.skipped.push(file);
          continue;
        }
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [version, file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }

  features.knowledgeBase = !!(await pool.query("SELECT to_regclass('public.kb_chunks') AS t")).rows[0].t;
  return result;
}
