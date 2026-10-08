# IoT Sentinel - Device Health & Security Monitoring Platform

Centralised monitoring for IoT fleets: device health, firmware status and security incidents in one dashboard, plus a
model that **predicts anomalies before they happen**.

**Stack:** React + TypeScript (Vite) · Node.js + Express.js (TypeScript) · PostgreSQL · Redis · REST API · Docker · Git/GitHub

## Run it

```bash
docker compose up -d --build      # postgres + redis + backend + frontend
```

| Service   | URL                          |
|-----------|------------------------------|
| Dashboard | http://localhost:8080        |
| REST API  | http://localhost:4000/api    |
| Postgres  | localhost:5433 (iot / iot)   |

**First run:** open the dashboard and choose *Create an account*. The first account on a fresh installation becomes the **administrator**; later sign-ups are read-only viewers.

On first boot the backend creates the schema, seeds a 14-device demo fleet (with 100 readings of history each) and
starts the **device simulator**, so the dashboard is live immediately.

Local development (infra in Docker, apps with hot reload):

```bash
docker compose up -d postgres redis
cd backend  && npm install && npm run dev      # http://localhost:4000
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxies /api)
```

## Architecture (as in the proposal)

```
IoT devices / simulator ──► REST API (Express) ──► PostgreSQL   (inventory, telemetry, alerts, firmware, incidents)
                                  │          └──► Redis        (heartbeat TTLs, latest state, rolling window, caches)
                                  └── anomaly predictor (TypeScript) ──► predictive alerts
React + TypeScript dashboard ◄──── REST API (polling)
```

* **Heartbeat / offline detection** - each heartbeat sets `hb:{id}` in Redis with a TTL; a sweeper marks a device offline and raises a critical alert when the key expires.
* **Rule-based alerts** - configurable warning/critical thresholds per metric (Alert Rules page).
* **Firmware tracking** - releases per device type, per-device compliance, controlled (simulated) rollouts. An old version is shown as a *maintenance signal*, never as proof of a vulnerability.
* **Security incidents** - consolidated queue with severity, category, status workflow and summaries.
* **Authentication & roles** - JWT sign-in, bcrypt-hashed passwords, admin (read/write) and viewer (read-only) roles, login rate-limiting in Redis.
* **Device keys** - shown once at registration, stored only as a SHA-256 hash, rotatable from the device page.
* **Activity workspace** - per-device history charts with limit lines, an alert lifecycle timeline (started → active → resolved) and raw readings with CSV export.
* **Simulator controls** - pause the fleet or trigger a fault on demand to demo missed-heartbeat detection and the predictor.
* **Anomaly prediction** - see below.

## Anomaly prediction model

`backend/src/ml/` - runs inside the Node backend (no extra runtime).

1. The last 20 readings of each metric come from the Redis rolling buffer.
2. A least-squares fit gives the denoised level, trend and volatility; features compare these with the alert limit (headroom, projected margin, trend ÷ headroom).
3. A **logistic-regression** classifier, trained on synthetic drift / leak / recovery episodes (`npm run train`), outputs the probability the limit is crossed in the next 20 readings.
4. Above 50 % a **predictive alert** opens with an estimated time-to-breach; it clears itself when the trend recovers.

Held-out evaluation (3 000 episodes): AUC ≈ 0.94, precision ≈ 89 %, recall ≈ 73 %, alert fires ≈ 7-8 readings before the breach. Live numbers are on the *Anomaly Prediction → Model card* panel.
Limitation: it is trained on synthetic data - the next phase retrains on real telemetry collected by the platform.

## REST API (summary)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/login` · GET/PATCH `/me` · POST `/me/password` | Accounts and sessions (Bearer JWT) |
| POST | `/api/telemetry`, `/api/telemetry/heartbeat` | Device ingest (`x-api-key` header, no user login) |
| GET/POST/DELETE | `/api/devices`, `/api/devices/:id` | Inventory |
| GET | `/api/devices/:id/telemetry`, `/readings?range=`, `/history` | Raw / averaged readings; alerts, incidents and updates for a device |
| POST | `/api/devices/:id/key` | Rotate a device key (returned once) |
| GET/POST | `/api/simulator`, `/pause`, `/resume`, `/inject-fault` | Demo controls |
| GET/PATCH | `/api/alerts` | List, acknowledge, resolve |
| GET/PUT | `/api/rules` | Threshold configuration |
| GET/POST | `/api/firmware/releases`, `/compliance`, `/updates`, `/updates/bulk` | Firmware management |
| GET/POST/PATCH | `/api/incidents`, `/summary` | Security incidents |
| GET | `/api/anomaly/predictions`, `/predictions/:id`, `/model` | Forecasts and model card |
| GET | `/api/dashboard/summary`, `/api/health` | Overview (Redis-cached), health check |

Send telemetry from a real device:

```bash
curl -X POST http://localhost:4000/api/telemetry -H "x-api-key: <key shown at registration>" \
  -H "Content-Type: application/json" -d '{"temperature":41.5,"cpu":22,"memory":48}'
```

## Status (~40 %+)

**Done:** React + TypeScript frontend (10 screens incl. sign-in, Activity and Account, mobile bottom navigation),
REST API, JWT authentication with roles, hashed device keys, PostgreSQL schema + seed, Redis integration, device simulator
with demo controls, rule-based alerts, missed-heartbeat detection, firmware tracking + simulated updates, incident
logging/reporting, anomaly-prediction model with forecast UI, telemetry retention, Dockerised stack.

**Remaining:** WebSocket/SSE push instead of polling, email/webhook notifications, automated tests + CI (GitHub Actions),
retraining the model on real telemetry, user management screen (promote viewers), PDF/CSV incident reports,
HTTPS and production hardening.

## Design inspiration

The sign-in flow, one-time device keys, separate Activity workspace (history vs. live monitoring), simulator controls and
mobile bottom navigation were inspired by the UX of [Merouanos/arduino-IoT](https://github.com/Merouanos/arduino-IoT).
No code was copied - everything here is implemented independently for this project's domain and stack.
