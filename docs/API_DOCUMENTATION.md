# REST API reference

Base URL: `http://localhost:4000/api` (or `/api` behind the dashboard at `http://localhost:8080`).
All bodies are JSON. Errors are `{ "error": "message" }` with an appropriate status (400 validation, 401 sign-in needed,
403 not allowed, 404, 409 conflict, 422 not enough data, 429 rate limited).

**Authentication.** User endpoints need `Authorization: Bearer <token>` (from `/auth/login` or `/auth/register`).
Device ingest uses `x-api-key: <device key>` instead. `GET` endpoints are open to any signed-in user; changes
(`POST` / `PUT` / `PATCH` / `DELETE`) need an **administrator**. Endpoints marked *admin* require an administrator even to read.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `name`, `email`, `password` (8+) | First account becomes admin, later ones viewers. Returns `{ token, user }` |
| POST | `/auth/login` | `email`, `password` | 10 failed attempts per IP per 15 min, then 429 |
| GET | `/auth/me` | | Current user |
| PATCH | `/auth/me` | `name?`, `email?` | |
| POST | `/auth/me/password` | `current`, `next` | 204 |

## Device ingest (device key, no user session)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/telemetry` | any of `temperature` `cpu` `memory` `battery` `signal` `vibration` `pressure` `current` | 202. Stores the reading, evaluates rules and the predictor |
| POST | `/telemetry/heartbeat` | none | 202. Liveness only |

Limited to 300 requests/min per device key.

## Devices

| Method | Path | Notes |
|---|---|---|
| GET | `/devices?status=&q=` | Inventory with status, firmware, latest readings |
| POST | `/devices` | `name`, `type` (an existing machine type), `firmwareVersion` (x.y.z), `location?`, `ipAddress?`, `simulated?`. The response contains `apiKey` **once** |
| GET | `/devices/:id` | |
| DELETE | `/devices/:id` | Removes the device and its history |
| POST | `/devices/:id/key` | Rotate the key; returns the new `apiKey` once, the old one stops working |
| GET | `/devices/:id/telemetry?limit=` | Raw recent readings |
| GET | `/devices/:id/readings?range=15m\|1h\|6h\|24h` | Averaged history (~150 points) |
| GET | `/devices/:id/history` | Recent alerts, incidents and firmware updates for the device |
| GET | `/devices/export.csv` | Inventory as CSV |

## Machine types

| Method | Path | Notes |
|---|---|---|
| GET | `/device-types` | Types with their signals, device count and model summary |
| POST | `/device-types` | `name`, `description?`, `metrics[]` (1-8 signals), `baselines?` (simulator start values) |
| PUT | `/device-types/:id` | `description?`, `metrics?` (the name is fixed) |
| DELETE | `/device-types/:id` | 409 while devices use it; also removes its limit overrides and model |

## Alert rules

| Method | Path | Notes |
|---|---|---|
| GET | `/rules` | Default rules |
| GET | `/rules?deviceType=NAME` | Rules that apply to a type (only its signals); `inherited: true` when no override exists |
| PUT | `/rules/:id` | `threshold?`, `enabled?` |
| PUT | `/rules/override` | `deviceType`, `metric`, `severity`, `threshold?`, `enabled?` - create or update a type's own limit |
| DELETE | `/rules/:id` | Remove an override (defaults cannot be deleted) |

## Alerts

| Method | Path | Notes |
|---|---|---|
| GET | `/alerts?status=active\|open\|acknowledged\|resolved&severity=&type=&deviceId=&rangeSec=` | |
| PATCH | `/alerts/:id` | `status`: `acknowledged` or `resolved` |
| GET | `/alerts/export.csv` | Same filters |

Alert `type` is `threshold` (limit crossed), `heartbeat` (device went silent) or `predictive` (model expects a breach). Alerts clear themselves when the condition recovers.

## Anomaly prediction

| Method | Path | Notes |
|---|---|---|
| GET | `/anomaly/predictions` | Fleet risk ranking, each device judged with its type's limits and model |
| GET | `/anomaly/predictions/:deviceId` | Recent points plus the forecast curve and confidence band per signal |
| GET | `/anomaly/models` | Scopes with a model: `global` plus machine types |
| GET | `/anomaly/model?scope=global\|TYPE` | Model card (weights, evaluation, source). `fallback: true` when the type uses the global model |
| POST | `/anomaly/retrain` | `{ deviceType }` - fit a model from that type's telemetry. 200 with `activated` and a `reason`; 422 when there is not enough labelled data |
| DELETE | `/anomaly/models/:scope` | Drop a type's own model (falls back to global) |

## Firmware

| Method | Path | Notes |
|---|---|---|
| GET | `/firmware/releases` / POST | Releases per machine type |
| GET | `/firmware/compliance` | Installed vs latest, missed security releases |
| GET | `/firmware/updates` | Recent rollouts |
| POST | `/firmware/updates` | `{ deviceId, toVersion? }` - start a (simulated) rollout. 409 for offline devices |
| POST | `/firmware/updates/bulk` | Update every online, outdated device |

## Security incidents

| Method | Path | Notes |
|---|---|---|
| GET | `/incidents?status=&severity=` | |
| GET | `/incidents/summary` | Counts by severity, category, status and the last 24 h |
| POST | `/incidents` | `category`, `severity`, `description`, `deviceId?` |
| PATCH | `/incidents/:id` | `status`: `open`, `investigating`, `resolved` |
| GET | `/incidents/export.csv` | |

## Notifications (webhooks) - admin

| Method | Path | Notes |
|---|---|---|
| GET | `/webhooks` | Webhooks and the available events; secrets are never listed |
| POST | `/webhooks` | `name`, `url`, `events[]`. The response contains the signing `secret` **once** |
| PUT | `/webhooks/:id` | `name?`, `url?`, `events?`, `enabled?` |
| DELETE | `/webhooks/:id` | |
| POST | `/webhooks/:id/test` | Sends a `test.ping` event |
| GET | `/webhooks/:id/deliveries` | Last 30 deliveries |

Events: `alert.critical`, `alert.predictive`, `incident.created` (high and critical only).
Each request is `POST` JSON `{ event, sentAt, text, content, data }` with headers `X-Sentinel-Event` and
`X-Sentinel-Signature: sha256=<hex>` = HMAC-SHA256 of the **raw body** with the webhook secret.
URLs on private, loopback or link-local addresses are refused, and redirects are not followed.

## Users - admin

| Method | Path | Notes |
|---|---|---|
| GET | `/users` | |
| PATCH | `/users/:id` | `{ role: "admin" \| "viewer" }`. The last administrator cannot be demoted |
| DELETE | `/users/:id` | Not yourself, and not the last administrator |

## Real-time events

`GET /events` - a Server-Sent-Events stream (send the bearer token in the header; use `fetch`, not `EventSource`).
It sends `hello` when ready, then events `{ type, data, ts }` where `type` is one of
`tick` (fresh telemetry, at most once per second), `alert`, `incident`, `firmware`, `device`, `rules`, `model`, `user`, `webhook`.

## Other

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status, postgres, redis, simulator }` - no sign-in needed |
| GET | `/dashboard/summary` | Fleet totals, alerts, incidents, firmware gaps, activity (Redis-cached for 2 s) |
| GET | `/simulator` | Simulator status |
| POST | `/simulator/pause` · `/resume` | Silence / restore all simulated devices |
| POST | `/simulator/inject-fault` | `{ deviceId, metric? }` - start a degradation on a simulated device |

Rate limits: 600 requests/min per IP for the API (`429` + `Retry-After` beyond that).

---

# Added in the platform-completion release

## Device lifecycle and maintenance history

| Method | Path | Notes |
|---|---|---|
| PATCH | `/devices/:id` | `active?` (take a device out of service / back into service - never deletes anything), `name?`, `location?`, `ipAddress?`, `firmwareVersion?`. Deactivating closes the device's open alerts, stops accepting its telemetry and removes it from fleet counts. Both transitions are recorded as maintenance entries |
| GET | `/devices/:id/maintenance` | Maintenance history, newest first |
| POST | `/devices/:id/maintenance` | `kind` (`inspection` `repair` `replacement` `calibration` `firmware` `activation` `note`), `summary` (3-200), `details?`, `performedAt?` (not in the future). Admin |
| DELETE | `/devices/:id/maintenance/:recordId` | Admin |

`GET /dashboard/summary?type=NAME` filters the fleet totals to one machine type; deactivated devices are counted separately (`totals.inactive`).

## Prediction history, versions and explanations

| Method | Path | Notes |
|---|---|---|
| GET | `/anomaly/history?deviceId=&metric=&before=&limit=` | Stored prediction snapshots (probability, level, time-to-breach, model version, **explanation**) |
| GET | `/anomaly/explain/:deviceId?metric=` | Why the model gave this risk: per-feature contribution to the log-odds (exact for a linear model), headroom, slope, which model version |
| GET | `/anomaly/models/:scope/versions` | Every trained version, including **rejected** retrains, with held-out evaluation |
| POST | `/anomaly/models/:scope/versions/:version/activate` | Roll back to an earlier version that passed the validation gate. Admin |

A probability means "a configured alert threshold will be crossed soon" - it is **not** a prediction of equipment failure. Models whose `source` is `synthetic` were trained on generated data.

## Audit log - admin

| Method | Path | Notes |
|---|---|---|
| GET | `/audit?action=&userId=&entity=&before=&limit=` | Who did what, when and from where. `action` is a prefix such as `kb`, `assistant`, `report`, `auth` |
| GET | `/audit/export.csv` | Same filters, up to 5000 rows |

Secrets, passwords, keys, document contents and chat text are never recorded.

## Knowledge base

Any signed-in user may upload and read documents (these routes are not admin-only). A document is **private** to its owner (and administrators) unless an administrator shares it with everyone.

| Method | Path | Notes |
|---|---|---|
| GET | `/knowledge/status` | Embedding/LLM provider health, document counts by status, upload limits |
| GET | `/knowledge?q=&status=` | Documents the caller may read |
| POST | `/knowledge` | `multipart/form-data`: `file` (PDF, DOCX, TXT, MD, CSV; size limit in `/knowledge/status`), `visibility?` (`private` default; `shared` is admin-only), `title?`. 202 - indexing continues in the background. 409 for an exact duplicate, 415 for a wrong or disguised file type |
| GET | `/knowledge/search?q=&limit=` | Hybrid (vector + keyword) search across readable documents. Falls back to keyword search, and says so in `note`, if the embedding model is down |
| GET | `/knowledge/:id` | Metadata and a preview of the first indexed passages. 404 - never 403 - for a document the caller may not see |
| PATCH | `/knowledge/:id` | `title?`, `visibility?` (owner or admin) |
| DELETE | `/knowledge/:id` | Owner or admin; removes passages and the stored file |
| POST | `/knowledge/:id/reindex` · `/knowledge/:id/retry` | Re-embed a document / retry a failed one |
| GET | `/knowledge/:id/download` | The original file (access-checked) |
| POST | `/knowledge/system/reindex` | Re-read the project's own `docs/*.md`. Admin |

Status values: `queued` -> `processing` -> `ready` or `failed` (with a readable `error`).

## AI Maintenance Assistant

Read-only for every role: it can answer questions but never changes devices, rules or records. Conversations are strictly private to their owner (administrators included).

| Method | Path | Notes |
|---|---|---|
| GET | `/assistant/health` | Provider/model availability, indexed-document counts, starter questions |
| GET / POST | `/assistant/conversations` | List / create (`title?`, `deviceId?` to focus on one device) |
| GET | `/assistant/conversations/:id` | The conversation with every message, its sources and the tools used |
| PATCH | `/assistant/conversations/:id` | `title?`, `deviceId?` |
| DELETE | `/assistant/conversations/:id` | 204 |
| GET | `/assistant/conversations/:id/export?format=md\|json` | Download a transcript including cited sources |
| POST | `/assistant/conversations/:id/messages` | `{ content }` (1-4000). **Streams** the answer as server-sent events |
| POST | `/assistant/conversations/:id/retry` | Answer the last question again (after an error or for a fresh attempt) |

Streaming events (`text/event-stream`):

| Event | Data |
|---|---|
| `meta` | `{ sources, toolCalls, kind, truncated }` - what the answer will be based on (sent before any text) |
| `token` | `{ text }` - a piece of the answer |
| `error` | `{ message, messageId, partial }` - generation failed or was stopped |
| `done` | `{ messageId, text, sources, cited, invalidCitations, uncited, error }` - the final, citation-verified text |

If the model service is unreachable before streaming starts, the response is a normal JSON error (`503`). One answer can be generated per conversation at a time (409 otherwise); limited to 20 messages/min per user.

Sources have ids `S1..` (document excerpts: file, page, section) and `D1..` (live platform data: tool, timestamp, simulated flag). Citations the model invents are removed and reported in `invalidCitations`.

## Reports

Read-only for every role. Filters: `from`, `to` (ISO times; default last 7 days, at most one year), `deviceId`, `machineType`, `includeSimulated` (default `true`).

| Method | Path | Notes |
|---|---|---|
| GET | `/reports` | The catalogue and which filters each report honours |
| GET | `/reports/:id` | JSON preview: columns, first 50 rows, `total`, scope, honesty notes |
| GET | `/reports/:id/csv` | The complete data, streamed in batches (BOM for Excel, formulas neutralised) |
| GET | `/reports/:id/pdf` | A readable A4-landscape PDF with page numbers (first 1000 rows; the CSV has everything) |

Report ids: `device-health`, `telemetry-history`, `alert-history`, `predictive-summary`, `machine-type-comparison`, `maintenance-history`, `model-performance`, `knowledge-base`.
Data from simulated devices is marked (`simulated` column, and a note on the report). Every export is audit-logged. Limited to 20 requests/min per user.

Real-time events gained `kb` (a document changed status) and `chat`.
