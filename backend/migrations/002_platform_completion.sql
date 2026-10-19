-- 002 platform completion: device activation, human-friendly device numbers, maintenance history,
-- prediction history, model versions and the audit log.

-- Devices can be deactivated (taken out of service) without being deleted, so history is kept.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- A short sequential number people can say out loud ("device 12"). Existing rows are numbered automatically.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS asset_no SERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS devices_asset_no_unique ON devices (asset_no);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id SERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inspection','repair','replacement','calibration','firmware','activation','note')),
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT NOT NULL DEFAULT 'system',
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_device_time ON maintenance_records (device_id, performed_at DESC);

-- Snapshots of what the model predicted and why. These are probabilities that a configured
-- THRESHOLD will be crossed - not equipment-failure labels.
CREATE TABLE IF NOT EXISTS prediction_history (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  probability REAL NOT NULL,
  level TEXT NOT NULL,
  seconds_to_breach REAL,
  threshold REAL NOT NULL,
  current_value REAL NOT NULL,
  slope_per_min REAL,
  model_scope TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_source TEXT NOT NULL,
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prediction_history_device_time ON prediction_history (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prediction_history_time ON prediction_history (created_at DESC);

-- Every trained model, including retrains that were REJECTED, so the decision trail is auditable.
CREATE TABLE IF NOT EXISTS model_versions (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  version INT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('synthetic','telemetry')),
  samples INT NOT NULL DEFAULT 0,
  evaluation JSONB NOT NULL,
  previous_evaluation JSONB,
  activated BOOLEAN NOT NULL DEFAULT FALSE,   -- passed the validation gate when it was trained
  is_active BOOLEAN NOT NULL DEFAULT FALSE,   -- the version currently used for predictions
  reason TEXT NOT NULL DEFAULT '',
  trained_by TEXT NOT NULL DEFAULT 'system',
  model JSONB NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS model_versions_one_active ON model_versions (scope) WHERE is_active;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_time ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user ON audit_logs (user_id, created_at DESC);
