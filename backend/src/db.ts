import { Pool } from 'pg';
import { config } from './config';
import { camelize } from './util';

export const pool = new Pool({ connectionString: config.databaseUrl });

/** Run a query and return camelCased rows. */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return camelize<T[]>(res.rows);
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'Unassigned',
  ip_address TEXT,
  firmware_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','degraded')),
  api_key TEXT NOT NULL UNIQUE,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  temperature REAL, cpu REAL, memory REAL, battery REAL, signal REAL
);
CREATE INDEX IF NOT EXISTS telemetry_device_ts ON telemetry (device_id, ts DESC);

CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('>','<')),
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (metric, severity)
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('threshold','heartbeat','predictive')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  metric TEXT,
  message TEXT NOT NULL,
  value REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_device ON alerts (device_id, type);

CREATE TABLE IF NOT EXISTS firmware_releases (
  id SERIAL PRIMARY KEY,
  device_type TEXT NOT NULL,
  version TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  security_patch BOOLEAN NOT NULL DEFAULT FALSE,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_type, version)
);

CREATE TABLE IF NOT EXISTS firmware_updates (
  id SERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','failed')),
  progress INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_incidents (
  id SERIAL PRIMARY KEY,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
