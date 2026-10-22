# Database schema

The platform uses two databases, each for what it is good at:

| Database | Holds | Why |
|---|---|---|
| **MongoDB 7** | Operational data: users, devices, telemetry, machine types, alert rules, alerts, firmware, security incidents, webhooks, maintenance, prediction history, model versions, audit log | Document-shaped records, high-volume time-stamped telemetry with automatic expiry (TTL index), flexible per-type signals |
| **PostgreSQL 16 + pgvector** | The RAG part only: knowledge-base documents and chunks (embeddings), assistant conversations and messages | Vector similarity search (HNSW), full-text search and the access-control predicate evaluated in a single SQL query |
| **Redis** | Heartbeat keys, latest reading, rolling window, caches, rate limits, locks, pub/sub | Speed and fan-out |

References between the two databases are plain ids (UUID strings for users and devices) with **no foreign keys**: `kb_documents.owner_id`, `chat_conversations.user_id` and `chat_conversations.device_id` point at MongoDB `users._id` / `devices._id`. The application resolves names when it needs them (for example the owner name on a document, the device name on a chat).

## MongoDB collections

Documents are stored in camelCase exactly as the REST API returns them. `users` and `devices` use UUID string `_id`s; every other collection uses a small integer `_id` from the `counters` collection (atomic `$inc`), so API ids stay short and stable. Indexes are created at start-up (`backend/src/mongo.ts`).

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | `_id` UUID, `email`, `name`, `passwordHash` (bcrypt), `role` (admin/viewer), `createdAt` | unique `email` |
| `devices` | `_id` UUID, `assetNo` (unique human-friendly number), `name`, `type`, `location`, `ipAddress`, `firmwareVersion`, `status`, `active`, `simulated`, `apiKeyHash` (SHA-256; the raw key is shown once), `lastSeen`, `createdAt` | unique `name`, unique `assetNo`, unique `apiKeyHash` (partial), `type` |
| `telemetry` | `deviceId`, `ts`, `temperature cpu memory battery signal vibration pressure current` | `(deviceId, ts desc)`; **TTL index on `ts`** = `TELEMETRY_RETENTION_DAYS` (MongoDB expires old readings itself) |
| `device_types` | `name`, `description`, `metrics[]`, `baselines` | unique `name` |
| `rules` | `metric`, `operator`, `threshold`, `severity`, `enabled`, `deviceType` (`null` = default for every type, otherwise an override) | unique `(metric, severity, deviceType)` |
| `alerts` | `deviceId`, `type` (threshold/heartbeat/predictive), `severity`, `metric`, `message`, `value`, `status` (open/acknowledged/resolved), `createdAt`, `resolvedAt` | `(status, createdAt)`, `(deviceId, type)` |
| `firmware_releases`, `firmware_updates` | releases per machine type; rollout progress per device | unique `(deviceType, version)`; `(deviceId, createdAt)` |
| `security_incidents` | `deviceId` (nullable), `category`, `severity`, `description`, `status`, timestamps | `createdAt`, `deviceId` |
| `webhooks`, `webhook_deliveries` | targets with an HMAC `secret`; the last 100 deliveries per webhook | `(webhookId, createdAt)` |
| `maintenance_records` | `deviceId`, `kind` (inspection/repair/replacement/calibration/firmware/activation/note), `summary`, `details`, `performedByName`, `performedAt` | `(deviceId, performedAt)` |
| `prediction_history` | `deviceId`, `metric`, `probability`, `level`, `secondsToBreach`, `threshold`, `currentValue`, `slopePerMin`, `modelScope/Version/Source`, `explanation` | `(deviceId, createdAt)`, `createdAt` |
| `models` | `_id` = scope (`global` or a machine type); the model currently used: weights, `source` (synthetic/telemetry), `samples`, `trainedAt` | — |
| `model_versions` | **every** training run including rejected ones: `scope`, `version`, `evaluation`, `previousEvaluation`, `activated` (passed the gate), `isActive`, `reason`, `trainedBy`, `model` | unique `(scope, version)`; **partial unique `(scope)` where `isActive`** = one active version per scope |
| `audit_logs` | `userId`, `userEmail`, `action`, `entity`, `entityId`, `details`, `ip`, `createdAt` | `createdAt`, `(action, createdAt)`, `(userId, createdAt)` |
| `counters` | `_id` = collection name, `seq` | — |

MongoDB has no foreign-key cascade: deleting a device removes its telemetry, alerts, firmware updates, maintenance and prediction history in application code (`deleteDeviceData`), and keeps its security incidents with the device link cleared.
Multi-document transactions are not used (a standalone server does not support them); every multi-step change is ordered so that an interruption leaves valid data (for example a new model version is inserted inactive, then activated).

## PostgreSQL tables (RAG only)

Schema changes here are **versioned SQL migrations** in `backend/migrations`, applied in order at start-up under an advisory lock and recorded with a checksum in `schema_migrations`.

| Migration | Contents |
|---|---|
| `001_baseline`, `002_platform_completion` | The original all-PostgreSQL schema. On a **fresh** install they still create the old operational tables (`users`, `devices`, `telemetry`, ...), which are **unused** — the knowledge-base tables of migration 003 were originally defined with foreign keys to them. They are kept so existing installations upgrade in place and can be copied to MongoDB (see the deployment guide) |
| `003_knowledge_base` | pgvector, `kb_documents`, `kb_chunks`, `chat_conversations`, `chat_messages` (`-- requires: vector`) |
| `004_split_from_operational_data` | Drops the foreign keys from the knowledge-base tables to `users` / `devices`, because those now live in MongoDB |

| Table | Purpose |
|---|---|
| `kb_documents` | `owner_id` (NULL for system docs), `source` (upload/system), `title`, `original_name` (sanitised display name), `stored_name` (random on-disk name), `mime`, `size_bytes`, `sha256`, `visibility` (private/shared), `status` (queued/processing/ready/failed), `error`, `attempts`, `pages`, `chunk_count`, `embedding_model/dim`. Unique `(owner, sha256)` stops duplicate uploads |
| `kb_chunks` | `document_id` (cascade delete), `chunk_index`, `content`, `page`, `section`, `embedding vector(1024)` with an **HNSW cosine index**, generated `tsv tsvector` with a **GIN index** |
| `chat_conversations` | `user_id` (owner), `title`, optional `device_id` context |
| `chat_messages` | `role`, `content`, `sources` JSONB (what each answer was based on), `tool_calls` JSONB, `model`, `latency_ms`, `error` |

## Redis (not part of either schema)

Heartbeat keys with TTL (offline detection), latest reading per device, a rolling window per device and signal for the predictor, short-lived dashboard/read caches, rate-limit counters, the assistant's per-conversation lock, and the pub/sub channel behind the SSE event stream.

## Moving an existing installation

`npm run migrate:to-mongo` (in `backend/`) copies every operational table from PostgreSQL into MongoDB, keeping ids, and is safe to run twice. `-- --dry-run` only counts. Nothing is deleted from PostgreSQL. See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).

## Changing the embedding model

The vector column is `vector(1024)`. A model with another dimension needs a new migration (alter the column, re-index every document via *Re-index* / `POST /api/knowledge/:id/reindex`); the provider refuses mismatched vectors with `dimension_mismatch` instead of storing them.
