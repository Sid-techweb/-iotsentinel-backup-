# IoT Sentinel - Device Health & Security Monitoring Platform

Centralised monitoring for IoT fleets: device health, firmware status and security incidents in one dashboard, plus a
model that **predicts anomalies before they happen** (and explains why), plus a local **AI Maintenance Assistant** that answers questions from live data and your own documents - always with sources.

**Stack:** React + TypeScript (Vite) · Node.js + Express.js (TypeScript) · **MongoDB** (operational data) · PostgreSQL + pgvector (the RAG part) · Redis · REST API · Docker · Git/GitHub
**AI additions:** Ollama (local models, nothing leaves your machine) · PDF/DOCX/CSV parsers · pdfkit (report PDFs)

[![CI](https://github.com/Sid-techweb/IoT-Sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/Sid-techweb/IoT-Sentinel/actions/workflows/ci.yml)

## Run it

```bash
docker compose up -d --build      # mongodb + postgres (pgvector) + redis + backend + frontend
```

| Service   | URL                                   |
|-----------|---------------------------------------|
| Dashboard | http://localhost:8080                 |
| REST API  | http://localhost:4000/api             |
| MongoDB   | localhost:27017 (iot / iot), local only |
| Postgres  | localhost:5433 (iot / iot), local only - knowledge base and chats |

**First run:** open the dashboard and choose *Create an account*. The first account on a fresh installation becomes the
**administrator**; later sign-ups are read-only viewers until an admin promotes them (Users screen).

On first boot the backend creates the schema, seeds a demo fleet (18 devices across 8 machine types, each with recent history)
and starts the **device simulator**, so the dashboard is live immediately. Copy `.env.example` to `.env` and set a real
`JWT_SECRET` before exposing it anywhere.

Local development (infrastructure in Docker, apps with hot reload):

```bash
docker compose up -d mongo postgres redis
cd backend  && npm install && npm run dev      # http://localhost:4000
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxies /api)
```

Tests (they use throw-away `iotmonitor_test` databases in MongoDB and PostgreSQL plus Redis database 1 - never your data):

```bash
cd backend  && npm test      # 176 tests (+3 opt-in live-model tests): model maths, API, auth, alerts, retraining, document parsing, RAG, assistant, reports
cd frontend && npm test      # 39 tests: renderer, streamed answers, upload, reports, sign-in, rules screen
cd e2e && npm install && npx playwright test   # 13-step end-to-end scenario in Chrome (own database and ports)
```

The AI assistant needs Ollama with a chat and an embedding model - see [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) (models are never downloaded automatically). Without it the rest of the platform works normally.

## Architecture

```
IoT devices / simulator ──► REST API (Express) ──► MongoDB      inventory, telemetry (TTL), alerts, rules, firmware, incidents, users, models, audit
                                  │          ├──► PostgreSQL   knowledge base + chats (pgvector: embeddings, full-text, access control)
                                  │          ├──► Redis        heartbeat TTLs, latest state, rolling window, caches, rate limits, pub/sub
                                  │          └──► Webhooks     signed notifications to Slack / Discord / any HTTPS endpoint
                                  └── anomaly predictor (TypeScript) ──► predictive alerts
React + TypeScript dashboard ◄──── REST API  +  Server-Sent Events (pushed through Redis pub/sub)
```

### What it does

* **Machine types** - each kind of machine (Smart Sensor, Gateway, CNC Machine, Pump Station, ... or your own) declares which
  of **8 signals** it reports: temperature, CPU, memory, battery, signal strength, vibration, pressure, motor current.
* **Per-type alert limits** - warning/critical limits are defaults for everyone, with overrides per machine type
  (a CNC machine may run hotter than a sensor). Edited from the *Alert Rules* screen.
* **Heartbeat monitoring** - each heartbeat sets a Redis key with a TTL; when it expires the device is marked offline and a critical alert opens.
* **Anomaly prediction** - see below. Models can be trained **per machine type from real telemetry**.
* **Real-time push** - alerts, incidents, firmware progress and fresh telemetry reach open dashboards instantly over SSE
  (Redis pub/sub fans events out to every API instance). Polling stays as a slow safety net.
* **Notifications** - signed webhooks for critical alerts, predicted breaches and high-severity incidents,
  with a delivery log and a "send test" button. Targets on private networks are refused (SSRF protection).
* **Firmware** - releases per machine type, per-device compliance, controlled (simulated) rollouts. An old version is a
  *maintenance signal*, never proof of a vulnerability.
* **Security incidents** - one triage queue with severity, status workflow, summaries and CSV export.
* **Activity workspace** - per-device history charts with limit lines, alert lifecycle timeline, raw readings, CSV export.
* **Accounts** - JWT sign-in, bcrypt passwords, admin / viewer roles, user management, login rate-limiting.
* **Device keys** - shown once, stored only as a SHA-256 hash, rotatable.
* **Demo controls** - pause the fleet or trigger a fault on demand to watch detection and prediction react.
* **Device lifecycle** - take a device out of service (keeps all history), per-device maintenance history, prediction history and an audit log.
* **Model versions** - every retrain (including rejected ones) is recorded; roll back to any version that passed the validation gate.
* **Explanations** - exact per-feature contributions for every prediction. Probabilities mean "a threshold will be crossed", never "the equipment will fail".
* **Knowledge Base** - upload PDF / DOCX / TXT / MD / CSV; they are validated, chunked, embedded (pgvector) and searchable. Private by default.
* **AI Maintenance Assistant** - streamed answers from read-only live-data tools and your documents, with verifiable `[S1]`/`[D1]` citations, owner-only chat history, no ability to change anything, and "I couldn't find that" instead of guessing.
* **Reports** - device health, telemetry history, alert history, predictive summary, machine-type comparison, maintenance history, model performance and KB inventory as CSV (streamed, complete) or PDF; simulated data is marked.

### The prediction model

`backend/src/ml/` - runs inside the Node backend (no extra runtime).

1. The last 20 readings of each signal come from the Redis rolling buffer.
2. A least-squares fit gives the denoised level, trend and volatility; features compare these with the machine type's alert limit
   (headroom, projected margin, trend ÷ headroom).
3. A **logistic-regression** classifier outputs the probability the limit is crossed in the next 20 readings.
4. Above 50 % a **predictive alert** opens with an estimated time-to-breach (the linear ETA must agree, otherwise the metric is only "elevated").

* **Global model** - trained on synthetic drift / leak / recovery episodes in normalised units (`npm run train`):
  AUC ≈ 0.94, precision ≈ 89 %, recall ≈ 73 % on held-out episodes. One model covers every signal.
* **Per-type models** - *Anomaly Prediction → Retrain from telemetry* builds labelled windows from the telemetry a machine type has
  actually produced, fits a model on the older 80 %, and tests it on the **most recent 20 %** it has not seen. It is only activated when
  it reaches AUC ≥ 0.70 and is not clearly worse than the model it would replace on the same data; otherwise the old model is kept and
  the screen says why. Types without their own model use the global one.
* **Honest limitation:** the demo's telemetry comes from the built-in simulator, so retrained metrics reflect simulated behaviour.
  With real devices the same pipeline learns real behaviour.

## Security notes

* Passwords: bcrypt. Sessions: signed JWT (12 h). Device keys: SHA-256 hashed, shown once.
* Viewers are read-only server-side; user management and webhooks are admin-only even to read.
* Rate limits (Redis, shared across instances): per IP for the API, per device key for ingest, and a login brute-force guard.
* Helmet on the API; nginx adds CSP, `X-Frame-Options`, `nosniff`; the backend container runs as a non-root user.
* Webhooks: HMAC-SHA256 signed, no redirects followed, private / loopback / link-local targets refused (checked on save and on every send).
* CSV exports neutralise spreadsheet formulas.
* Postgres and Redis ports are bound to `127.0.0.1` in Compose.
* Not yet included: HTTPS termination (put the stack behind a TLS proxy or load balancer), email delivery, secret rotation tooling.

## REST API

See [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) for the full reference. More documentation: [architecture](docs/ARCHITECTURE.md) · [ML model](docs/ML_MODEL_DOCUMENTATION.md) · [RAG](docs/RAG_ARCHITECTURE.md) · [database](docs/DATABASE_SCHEMA.md) · [deployment](docs/DEPLOYMENT_GUIDE.md) · [testing](docs/TESTING_GUIDE.md) · [demo walkthrough](docs/DEMO_GUIDE.md) · [completion tracker](PROJECT_COMPLETION_TRACKER.md). Send telemetry from a real device:

```bash
curl -X POST http://localhost:4000/api/telemetry -H "x-api-key: <key shown at registration>" \
  -H "Content-Type: application/json" -d '{"temperature":41.5,"cpu":22,"memory":48}'
```

## Project status

See [PROJECT_COMPLETION_TRACKER.md](PROJECT_COMPLETION_TRACKER.md) for the item-by-item status with evidence.

**Done and verified:** everything in the feature list above, versioned migrations, hardened Docker/nginx deployment, 176 backend + 39 frontend + 13 end-to-end tests passing locally.

**Known limitations:**
* The default chat model `qwen2.5:7b` does not fit a 6 GB laptop GPU (verified with `phi4-mini`); pick a model with `LLM_MODEL`.
* Inside Docker the backend cannot reach an Ollama bound to `127.0.0.1` (see the deployment guide); run the backend locally or expose Ollama deliberately.
* Models trained on simulator data describe the simulator, not real machines.
* The GitHub Actions workflow (including the new end-to-end job) has not run yet.
* Not included: HTTPS termination, email notifications, OCR for scanned PDFs, real-device protocol gateways (MQTT).

## Design inspiration

The sign-in flow, one-time device keys, separate Activity workspace (history vs. live monitoring), simulator controls and
mobile bottom navigation were inspired by the UX of [Merouanos/arduino-IoT](https://github.com/Merouanos/arduino-IoT).
No code was copied - everything here is implemented independently for this project's domain and stack.
