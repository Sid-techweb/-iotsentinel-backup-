# Project completion tracker

Legend: ✅ verified working (how it was verified is stated) · 🟡 partial · ❌ missing · ⛔ blocked · ⏳ in progress

_Audit date: 2026-10-15 · Completion update: 2026-10-19 (backend 176 / frontend 39 / end-to-end 13 tests passing, including after the MongoDB split) · Baseline verified by running `npm test` (87 backend + 17 frontend tests, all passing), both typechecks, both production builds and the Docker stack._

## Phase 1 - Audit of the existing codebase

### Existing platform (verified)

| Area | Status | Evidence |
|---|---|---|
| Authentication (JWT, bcrypt, admin/viewer roles, protected routes) | ✅ | 87 backend tests incl. auth/access-control; live browser checks |
| Device registration, key hashing/rotation, delete | ✅ | `tests/api/devices.test.ts` |
| Machine types with per-type signals (8 signals) | ✅ | `tests/api/types-rules.test.ts` |
| Per-type alert limits (override/reset) | ✅ | `tests/api/types-rules.test.ts`, frontend `screens.test.tsx` |
| Telemetry ingest + validation (zod ranges) | ✅ | `tests/api/devices.test.ts` |
| Threshold alerts, auto-resolve, heartbeat/offline detection | ✅ | `tests/api/alerts.test.ts` |
| Predictive alerts (logistic regression, time-to-breach) | ✅ | `tests/unit/ml.test.ts`, `tests/api/alerts.test.ts` |
| Per-type retraining, time-based split, activation gate (AUC ≥ 0.70) | ✅ | `tests/api/retrain.test.ts` |
| Redis pub/sub → SSE → dashboard (reconnect with backoff) | ✅ | `tests/api/platform.test.ts`; live: alert visible in an open page in 0.07 s |
| Webhooks (HMAC, SSRF guard, delivery log) | ✅ | `tests/api/webhooks.test.ts` |
| Rate limiting (Redis), login brute-force guard | ✅ | `tests/api/platform.test.ts`, `auth.test.ts` |
| Firmware tracking/rollouts, incidents, CSV exports (devices/alerts/incidents) | ✅ | `tests/api/platform.test.ts` |
| Simulator with machine-specific profiles | ✅ | live; seeds 18 devices / 8 types |
| Docker Compose stack, healthchecks, non-root backend, nginx CSP | ✅ | `docker compose up`, headers checked, 12 screens loaded with no CSP errors |

### Gaps found by the audit (everything below the line is work still to do)

| Requirement | Finding |
|---|---|
| Device activation/deactivation | ❌ no `active` flag, no update endpoint |
| Per-device maintenance history | ❌ no table / API / UI |
| Prediction history | ❌ predictions are computed on demand and never stored |
| Model versioning | 🟡 a single `version` string; no version history, no record of rejected retrains |
| Prediction explanation | 🟡 model card shows global weights only; no per-prediction contribution breakdown |
| Audit logs | ❌ none |
| Versioned DB migrations | 🟡 idempotent `migrate()` only - no migration table, not reviewable per change |
| Reports: PDF, telemetry/predictive/type-comparison/maintenance/model/KB reports | ❌ only CSV for devices, alerts, incidents |
| Dashboard: machine-type filter, risk distribution | ❌ |
| Linting | ❌ no ESLint config in either package |
| End-to-end tests (Playwright) | ❌ |
| Live-LLM tests (run separately from CI) | ❌ |
| Docs: ARCHITECTURE, ML_MODEL_DOCUMENTATION, RAG_ARCHITECTURE, DATABASE_SCHEMA, DEPLOYMENT_GUIDE, TESTING_GUIDE, DEMO_GUIDE | ❌ (README + API reference exist) |
| JWT secret | 🟡 insecure development default when `JWT_SECRET` is unset |
| Docker: pgvector, Ollama integration, persistent upload/model volumes, resource limits, low-memory profile | ❌ |
| **RAG / AI Maintenance Assistant (entire module)** | ❌ nothing exists |
| Knowledge Base (upload/ingest/search/download/reindex) | ❌ |

### Environment facts that shape the design

* Ollama 0.33.3 is installed on the host; models **already present locally**: `qwen2.5:7b` (4.7 GB), `qwen3-embedding:0.6b` (0.6 GB), `phi4-mini` (2.5 GB), `qwen3.5:4b` (3.4 GB). **No model needs to be downloaded.** `nomic-embed-text` is *not* installed, so the default embedding model is `qwen3-embedding:0.6b` (configurable).
* Machine: 15.8 GB RAM, 19.5 GB free disk, RTX 4050 laptop GPU.
* The running Postgres image has no pgvector → needs a custom image (built from `postgres:16-alpine` so existing data and collation stay valid).

## Phase 2 - Core platform completion

| Item | Status |
|---|---|
| Versioned SQL migrations with a `schema_migrations` table | ✅ 3 migrations applied to the live DB (after a backup) and to a fresh test DB; re-run applies nothing (`platform2.test.ts`) |
| Device activation / deactivation + device update endpoint | ✅ telemetry refused, alerts closed, excluded from counts/predictions, history kept (`platform2.test.ts`; browser-checked) |
| Maintenance history (table, API, UI) | ✅ manual + automatic firmware/activation entries (`platform2.test.ts`; browser-checked) |
| Prediction history (stored snapshots, API, UI) | ✅ throttled snapshots with model version + explanation (`platform2.test.ts`) |
| Model versions (history, rejected retrains recorded) | ✅ version table, validation gate, rollback, rejected versions cannot be activated (`platform2.test.ts`) |
| Per-prediction explanation (exact logistic-regression contributions) | ✅ contributions sum to the logit and match `scoreFeatures` to 1e-9 (`platform2.test.ts`) |
| Audit log (table, writes on security-relevant actions, admin UI) | ✅ no secrets recorded, admin-only, filter/paginate/CSV (`platform2.test.ts`); KB/assistant/report actions are added in later phases |
| Human-friendly device numbers (`asset_no`) | ✅ unique, searchable (`platform2.test.ts`) |
| Secure JWT secret default (generated and persisted, never hard-coded) | ✅ implemented in `config.ts`; compose passes an empty value; generated file verified on first start |
| Dashboard: machine-type filter, risk distribution, empty-state check | ✅ filter + empty type return zeros (`platform2.test.ts`); risk distribution browser-checked. Full empty-database check is part of the Playwright suite |

## MongoDB split (branch `mongodb-migration`, 2026-10-19)

Requested: operational data in MongoDB; PostgreSQL (pgvector) only for the RAG part.

| Item | Status | Evidence |
|---|---|---|
| MongoDB 7 in Docker Compose (auth, healthcheck, volume, localhost-only port) | ✅ | `docker compose up -d mongo` healthy; `docker compose config` valid |
| Data layer ported: users, devices, telemetry (TTL index), machine types, rules, alerts, firmware, incidents, webhooks, maintenance, prediction history, model versions, audit log, simulator, sweeper, dashboard | ✅ | backend API suite passes on MongoDB: 176 passed / 3 skipped |
| Assistant tools and reports ported to MongoDB queries; knowledge base joins (owner names, chat device names) resolved in the application | ✅ | `assistant.test.ts`, `reports.test.ts`, end-to-end step 09-12 |
| PostgreSQL migration 004 removes cross-database foreign keys | ✅ | `platform2.test.ts` |
| Existing data copied: `npm run migrate:to-mongo` (ids preserved, idempotent, dry-run, never deletes) | ✅ | real data: 18 devices, 100,614 readings, 1,408 alerts, 1,462 predictions copied with exact counts; second run added nothing |
| New backend running against the migrated data | ✅ | dashboard, device list and predictions return the migrated fleet |
| End-to-end (13 steps) on MongoDB | ✅ | 13 passed |
| Frontend | ✅ unchanged | API response shapes were kept; 39 frontend tests pass |
| CI workflow has a MongoDB service for the backend and end-to-end jobs | 🟡 | written, not run on GitHub |
| Fresh PostgreSQL installs still create the old, now unused operational tables (migrations 001/002 are history) | 🟡 | harmless; documented in `DATABASE_SCHEMA.md` |
| Old PostgreSQL operational tables | kept | deliberately not dropped - they are the backup until you decide |
| Docker images (backend/frontend) rebuilt with the MongoDB code and started | see below | |

## Phase 3 - RAG infrastructure

| Item | Status | Evidence |
|---|---|---|
| Postgres + pgvector image, migration 003, HNSW + GIN indexes | ✅ | image built from `docker/postgres/Dockerfile`; `platform2.test.ts` checks extension + columns; live stack running on it |
| LLM/embedding provider abstraction + Ollama provider (health, time-outs, streaming, structured errors) | ✅ | live health call; `assistant.test.ts` (failure paths); embedding dimension verified = 1024 |
| Upload validation (size, type, magic bytes, UTF-8, zip bomb, filename, duplicates) | ✅ | `tests/unit/kb.test.ts` (renamed executable, 250 MB zip bomb, traversal filenames), `assistant.test.ts` (dedupe), upload through nginx |
| Extractors: PDF (per page), DOCX, TXT, MD, CSV | ✅ | `tests/unit/kb.test.ts` builds real PDF/DOCX files |
| Chunking with configurable size/overlap, page + heading metadata | ✅ | `tests/unit/kb.test.ts` |
| Background ingestion queue (restart-safe, retry/back-off, reindex) | ✅ | exercised by every upload test; live ingestion with Ollama |
| Knowledge Base API + page (list, search, delete, download, metadata, status, visibility) | ✅ | API tests; `frontend/tests/assistant.test.tsx`; browser-checked; E2E step 08 |
| Application documentation indexed as shared knowledge | ✅ | `docs/*.md` indexed at start-up (live: "REST API reference" ready) |

## Phase 4 - AI Maintenance Assistant

| Item | Status | Evidence |
|---|---|---|
| Hybrid retrieval (vector + keyword, rank fusion) with access control | ✅ | `assistant.test.ts`: another user's private document never reaches the prompt or the answer; shared documents work |
| Retrieval relevance gate calibrated on the real embedding model | ✅ | measured unrelated 0.30–0.35 vs related 0.45–0.80 → gate 0.40 + relative margin; off-topic question gets no sources |
| Read-only live-data tools (12), deterministic planner, no LLM-written SQL, bounded, audited | ✅ | `assistant.test.ts`; tool use visible in the audit log (E2E step 13) |
| Prediction explanation tool | ✅ | reads the model's exact contributions |
| Grounded prompt, untrusted-content handling, citation verification | ✅ | `kb.test.ts` (markers, fake citations, invented ids removed), `assistant.test.ts` (injection stays inside markers) |
| Streaming chat API + conversation history, owner-only, rate limit, one generation at a time | ✅ | `assistant.test.ts` (16 tests) |
| Chat UI (sidebar, new/rename/delete, suggestions, markdown, code copy, citations + source cards, device context, retry/stop, export, responsive) | ✅ | 12 frontend tests; browser-checked with a real model |
| Verified with the **default** chat model `qwen2.5:7b` | ⛔ | does not fit this machine's 6 GB GPU (out-of-memory); verified with `phi4-mini` instead – see blockers |
| Resistance to prompt injection with a real model | 🟡 | one planted-instruction document, one model (phi4-mini) – a single passing test, not proof of robustness |

## Phase 5 - Reports, security, UX

| Item | Status | Evidence |
|---|---|---|
| Reports (8 types + KB inventory), preview, streaming CSV (4,500-row batch test), PDF, filters, simulated data marked | ✅ | `tests/api/reports.test.ts` (28 tests), `frontend/tests/reports.test.tsx`, E2E step 12; CSV/PDF verified through nginx |
| PDF visual layout | 🟡 | structure/pagination tested and text extractable, but I could not render pages to look at them |
| "Explain this report" via the assistant | ✅ | link opens the assistant with a prepared question (not a separate model call) |
| Audit log screen + audit of KB / assistant / report actions | ✅ | `platform2.test.ts`, `reports.test.ts`, E2E step 13 |

## Phase 6 - Testing and delivery

| Item | Status | Evidence |
|---|---|---|
| Linting (backend + frontend) clean | 🟡 | **oxlint**, not ESLint: typescript-eslint does not support TypeScript 7 which the project uses. Both packages report 0 warnings/errors |
| Backend unit/service/API/RAG/security tests | ✅ | 176 passed, 3 skipped (live-model tests, opt-in) |
| Frontend component tests (assistant, upload, devices, dashboard, reports) | ✅ | 39 passed |
| Playwright end-to-end (13-step scenario, own database, deterministic AI provider) | ✅ | 13 passed locally in Chrome |
| Live Ollama tests (separate from CI, `RUN_LIVE_LLM=1`) | ✅ | 3 passed with `phi4-mini` + `qwen3-embedding` |
| GitHub Actions: lint, typecheck, tests (no Ollama/GPU), builds, E2E job, audit | 🟡 | workflow written; **not yet run on GitHub** (pgvector service image and Playwright-in-CI are unverified there) |
| Docker Compose build + start | ✅ | rebuilt all images; healthy; uploads (800 KB) / PDF / CSV verified through nginx. Not re-verified from a fully empty set of volumes (`down -v`) – the empty-database path is covered by the API and E2E suites |
| Assistant inside the Docker stack | ⛔ | a host Ollama bound to 127.0.0.1 is unreachable from containers – see blockers |

## Phase 7 - Documentation and demo

| Item | Status |
|---|---|
| README, ARCHITECTURE, API_DOCUMENTATION, ML_MODEL_DOCUMENTATION, RAG_ARCHITECTURE, DATABASE_SCHEMA, DEPLOYMENT_GUIDE, TESTING_GUIDE, DEMO_GUIDE | ✅ |
| Demo data (`docs/demo/`) and walkthrough | ✅ |

## Bugs found and fixed

Phase 2:

* History endpoints (`/devices/:id/telemetry`, `/readings`) selected only the original 5 signals, so vibration / pressure / motor-current history never appeared for CNC and pump machines. Fixed + regression test.
* The dashboard summary cache (2 s) served stale counts after a device was deactivated/created/deleted. The cache is now cleared on device changes.
* PostgreSQL `bigint` ids were returned to the API as strings. They are now numbers.
* Retraining could leak information through its look-ahead labels at the train/test boundary. A purge gap of WINDOW + HORIZON readings is now dropped between the two; the result reports how many windows were purged.
* Recent-alerts list on the device page: the type badge overlapped the message (CSS column too narrow).

Phases 3–6:

* nginx would have rejected document uploads (200 KB body limit) and buffered / timed out streamed assistant answers; separate locations added for `/api/assistant/`, `/api/knowledge` and `/api/reports/`.
* The backend image did not contain `migrations/` and could not write `/data`; fixed (and `docs/` is mounted read-only so the assistant can index it).
* Relevance gate (0.25) let unrelated documents through for the real embedding model; recalibrated from measurements (0.40 + relative margin) and pure live-data questions no longer retrieve documents.
* A live test's regular expression lost its `\s` inside a template literal (found by the linter).
* Ollama kept the embedding model in GPU memory and starved the chat model; `EMBED_KEEP_ALIVE` (default `0`) unloads it right after use.

## Known blockers / decisions needing approval

1. **Assistant in Docker:** Ollama on Windows listens on `127.0.0.1`; containers reach the host through another address. Fixing it means binding Ollama to all interfaces (`OLLAMA_HOST=0.0.0.0`, a network-exposure decision for you), running Ollama in Compose (large model download), or running the backend outside Docker. Everything else in the Docker stack works; the assistant reports "model service not reachable" cleanly.
2. **Default chat model on this machine:** `qwen2.5:7b` runs out of GPU memory on the 6 GB RTX 4050. Options: keep using `phi4-mini` (installed), or download `qwen2.5:3b` (~1.9 GB, needs your approval).
3. **GitHub Actions** has not run yet; the first run may need small fixes.
