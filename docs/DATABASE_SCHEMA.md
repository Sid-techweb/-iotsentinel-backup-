# Database schema

PostgreSQL 16 with the **pgvector** extension (image built from `docker/postgres/Dockerfile`; the schema runs without it, with the assistant disabled).
Schema changes are **versioned SQL migrations** in `backend/migrations`, applied in order at start-up under an advisory lock and recorded with a checksum in `schema_migrations`. Every statement is idempotent, so databases created by earlier versions upgrade in place and nothing is dropped.

| Migration | Contents |
|---|---|
| `001_baseline` | The original schema: devices, users, telemetry, rules, alerts, firmware, incidents, machine types, models, webhooks |
| `002_platform_completion` | Asset numbers, maintenance history, prediction history, model versions, audit log |
| `003_knowledge_base` | pgvector, knowledge documents and chunks, chat conversations and messages (`-- requires: vector`) |

## Core monitoring

| Table | Purpose / key columns |
|---|---|
| `devices` | `id` UUID, `asset_no` (unique, human-friendly), `name` (unique), `type`, `location`, `firmware_version`, `status` (online/offline/degraded), `active` (in service), `simulated`, `api_key_hash` (SHA-256; the raw key is shown once), `last_seen` |
| `telemetry` | `device_id`, `ts`, eight nullable signals: `temperature cpu memory battery signal vibration pressure current`. Index `(device_id, ts DESC)`. Pruned after `TELEMETRY_RETENTION_DAYS` |
| `device_types` | Machine types: `name`, `metrics[]` it reports, `baselines` for the simulator |
| `rules` | Alert limits: `metric`, `operator`, `threshold`, `severity`, `enabled`, `device_type` (NULL = default for all; otherwise an override) |
| `alerts` | `type` (threshold/heartbeat/predictive), `severity`, `metric`, `value`, `status` (open/acknowledged/resolved), `created_at`, `resolved_at` |
| `firmware_releases`, `firmware_updates` | Releases per machine type; rollout progress per device |
| `security_incidents` | Category, severity, status workflow, optional device |
| `webhooks`, `webhook_deliveries` | Notification targets (HMAC secret) and a delivery log |
| `users` | `email`, `name`, `password_hash` (bcrypt), `role` (admin/viewer) |

## Prediction

| Table | Purpose |
|---|---|
| `models` | The model currently used per scope (`global` or a machine-type name): weights JSON, `source` (synthetic/telemetry), `samples`, `trained_at` |
| `model_versions` | **Every** training run including rejected ones: `scope`, `version`, `evaluation` and `previous_evaluation` (JSON), `activated` (passed the gate), `is_active` (one per scope, enforced by a partial unique index), `reason`, `trained_by`, the model itself |
| `prediction_history` | Snapshots: `device_id`, `metric`, `probability`, `level`, `seconds_to_breach`, `threshold`, `current_value`, `slope_per_min`, `model_scope/version/source`, `explanation` JSONB |
| `maintenance_records` | `device_id`, `kind` (inspection/repair/replacement/calibration/firmware/activation/note), `summary`, `details`, `performed_by(_name)`, `performed_at` |

## Knowledge base and assistant

| Table | Purpose |
|---|---|
| `kb_documents` | `owner_id` (NULL for system docs), `source` (upload/system), `title`, `original_name` (sanitised display name), `stored_name` (random on-disk name), `mime`, `size_bytes`, `sha256`, `visibility` (private/shared), `status` (queued/processing/ready/failed), `error`, `attempts`, `pages`, `chunk_count`, `embedding_model/dim`. Unique `(owner, sha256)` stops duplicate uploads |
| `kb_chunks` | `document_id` (cascade delete), `chunk_index`, `content`, `page`, `section`, `embedding vector(1024)` with an **HNSW cosine index**, generated `tsv tsvector` with a **GIN index** |
| `chat_conversations` | `user_id` (owner), `title`, optional `device_id` context |
| `chat_messages` | `role`, `content`, `sources` JSONB (what each answer was based on), `tool_calls` JSONB, `model`, `latency_ms`, `error` |

## Audit

`audit_logs` — `user_id`, `user_email`, `action` (e.g. `auth.login`, `device.update`, `model.retrain`, `kb.upload`, `assistant.tool`, `report.export`), `entity`, `entity_id`, `details` JSONB, `ip`, `created_at`.
Secrets, passwords, document contents and chat text are never stored here.

## Redis (not part of the relational schema)

Heartbeat keys with TTL (offline detection), latest reading per device, a rolling window per device and signal for the predictor, short-lived dashboard/read caches, rate-limit counters, the assistant's per-conversation lock, and the pub/sub channel behind the SSE event stream.

## Changing the embedding model

The vector column is `vector(1024)`. A model with another dimension needs a new migration (alter the column, re-index every document via *Re-index* / `POST /api/knowledge/:id/reindex`); the provider refuses mismatched vectors with `dimension_mismatch` instead of storing them.
