# Architecture

IoT Sentinel monitors the health and security of IoT / industrial devices, predicts threshold breaches before they happen, and
answers maintenance questions from live platform data and uploaded documents.

**Stack (mandatory):** React + TypeScript (Vite) · Node.js + Express.js (TypeScript) · PostgreSQL · Redis · REST API · Docker · Git/GitHub.
**Added for the AI work:** pgvector (PostgreSQL extension), Ollama (local models), PDF / DOCX / CSV parsers, pdfkit (report PDFs), Vitest + Supertest + Testing Library.

## Component view

```
                 ┌────────────────────────── React + TypeScript (Vite, TanStack Query, Recharts) ──────────────────────────┐
                 │ Dashboard · Devices · Alerts · Anomaly · Activity · Reports · AI Assistant · Knowledge Base · Admin       │
                 └───────────────▲──────────────────────────────▲───────────────────────────────▲────────────────────────┘
                       REST + JWT│                  SSE (events) │                    SSE (answer tokens)│
┌──────────────┐        ┌────────┴──────────────────────────────┴───────────────────────────────┴────────┐
│ IoT devices  │ x-api- │                         Express API (TypeScript)                                 │
│ / simulator  ├───key─►│ auth · devices · telemetry · alerts · rules · firmware · incidents · webhooks    │
└──────────────┘        │ anomaly (predictor, versions, explanations) · reports · audit                    │
                        │ knowledge (upload, ingestion queue, hybrid retrieval)                            │
                        │ assistant (planner → read-only tools + retrieval → grounded prompt → stream)     │
                        └────┬───────────────────┬──────────────────────────────┬─────────────────────────┘
                             │                   │                              │
                  ┌──────────▼────────┐  ┌───────▼───────┐             ┌────────▼──────────┐
                  │ PostgreSQL 16     │  │ Redis         │             │ Ollama (local)    │
                  │ + pgvector        │  │ heartbeats,   │             │ chat model +      │
                  │ relational data,  │  │ rolling window│             │ embedding model   │
                  │ vectors, FTS      │  │ caches, rate  │             │ (no data leaves   │
                  └───────────────────┘  │ limits, pubsub│             │  the machine)     │
                                         └───────────────┘             └───────────────────┘
```

## Request flows

**Telemetry.** A device posts readings with its key → the key hash is looked up → the reading is stored, the latest state and a
rolling window go to Redis → rules are evaluated (threshold alerts, auto-resolve) → the predictor scores the window and may open a
*predictive* alert and record a prediction snapshot (with its explanation) → an event is published over Redis pub/sub and pushed to
open dashboards by SSE. A heartbeat key with a TTL detects silent devices.

**Prediction.** `backend/src/ml/` (logistic regression, features from the last 20 readings) → per machine-type models with versioning and
a validation gate (see [ML_MODEL_DOCUMENTATION.md](ML_MODEL_DOCUMENTATION.md)).

**Document ingestion.** Upload → validate (extension + magic bytes, UTF-8, zip-bomb scan) → store under a random name → DB-backed queue
→ extract → clean → chunk → embed → store vectors. Failures retry with back-off, then show a readable error (see [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md)).

**Assistant answer.** A deterministic planner picks read-only tools from the question → tools query live data → hybrid retrieval finds
document excerpts the user may read → a grounded prompt labels every source → the model streams an answer → citations are verified
against the labelled sources before the final message is stored.

**Reports.** One parameterised SQL definition per report drives the preview, a batch-paginated CSV stream and a PDF.

## Cross-cutting design decisions

| Concern | Decision |
|---|---|
| Schema changes | Versioned SQL migrations (`backend/migrations`, `schema_migrations` with checksums, advisory lock). Existing data is never dropped. Migration 003 needs pgvector; without it the platform still runs with the assistant disabled |
| Authentication | JWT (12 h), bcrypt; devices use hashed API keys. The signing secret is `JWT_SECRET` or generated once and persisted in the data volume — never hard-coded |
| Authorisation | Viewers are read-only server-side. Documents: owner / shared / admin predicate applied in list, search, download **and retrieval**. Conversations: owner only |
| AI safety | The model never chooses tools or writes SQL; tools are fixed, read-only, bounded (time-out, row limits) and logged. Document text is untrusted data: wrapped in markers, with fake markers/citations neutralised, never placed in the system prompt |
| Honesty | Predictions are probabilities of a *threshold crossing*, not equipment failure. Synthetic-data models are labelled. Simulated devices are marked in reports and assistant answers |
| Auditability | `audit_logs` records security-relevant actions (never secrets or message text) with an admin UI and CSV export |
| Resilience | Ollama down → clear errors, uploads queue and resume, keyword search fallback. Redis/DB outages surface in `/api/health` |
| Real time | One SSE stream per browser; Redis pub/sub fans events out to every API instance; polling remains a slow safety net |

## Repository layout

```
backend/src/{routes,services,ml,middleware}   API, domain logic, predictor
backend/src/services/ai   provider abstraction (Ollama + a labelled test double), tool planner, tools, RAG, chat store
backend/src/services/kb   extraction, chunking, ingestion queue, hybrid search
backend/migrations        versioned SQL
backend/tests             unit, API (real Postgres/Redis/pgvector), live-model tests (opt-in)
frontend/src              pages, components, API client, SSE client
docker/postgres           PostgreSQL + pgvector image
docs                      this documentation (also indexed for the assistant)
```
