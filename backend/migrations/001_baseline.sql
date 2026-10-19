-- 001 baseline: the schema as it existed before versioned migrations were introduced.
-- Every statement is idempotent, so databases created by earlier versions of the project
-- upgrade in place: nothing is dropped or rewritten, missing pieces are added.

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'Unassigned',
  ip_address TEXT,
  firmware_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','degraded')),
  api_key TEXT UNIQUE,          -- legacy plaintext column, emptied at start-up by the legacy-key step
  api_key_hash TEXT UNIQUE,     -- SHA-256 of the device key; the raw key is shown once
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_hash TEXT UNIQUE;
ALTER TABLE devices ALTER COLUMN api_key DROP NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  temperature REAL, cpu REAL, memory REAL, battery REAL, signal REAL,
  vibration REAL, pressure REAL, current REAL
);
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS vibration REAL;
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS pressure REAL;
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS current REAL;
CREATE INDEX IF NOT EXISTS telemetry_device_ts ON telemetry (device_id, ts DESC);

CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('>','<')),
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  device_type TEXT            -- NULL = default for every machine type; otherwise an override for that type
);
ALTER TABLE rules ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE rules DROP CONSTRAINT IF EXISTS rules_metric_severity_key;
CREATE UNIQUE INDEX IF NOT EXISTS rules_scope_unique ON rules (metric, severity, COALESCE(device_type, ''));

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

CREATE TABLE IF NOT EXISTS device_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  metrics TEXT[] NOT NULL,
  baselines JSONB NOT NULL DEFAULT '{}'::jsonb,   -- starting values used by the simulator
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the active prediction model per scope: 'global' or a machine type name
CREATE TABLE IF NOT EXISTS models (
  scope TEXT PRIMARY KEY,
  model JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('synthetic','telemetry')),
  samples INT NOT NULL DEFAULT 0,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  status_code INT,
  error TEXT,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_recent ON webhook_deliveries (webhook_id, created_at DESC);
