# Testing guide

Last verified run (2026-10-19, local machine): backend **176 passed / 3 skipped**, frontend **39 passed**, end-to-end **13 passed**, live-model tests **3 passed** (run separately), typecheck and lint clean for both packages.
GitHub Actions runs the same suites but had not yet run at the time of writing — see [PROJECT_COMPLETION_TRACKER.md](../PROJECT_COMPLETION_TRACKER.md) for the honest status of every item.

## Layers

| Layer | Where | What it covers | Needs |
|---|---|---|---|
| Backend unit | `backend/tests/unit` | Prediction maths and evaluation, utilities, **document parsing, chunking, upload validation, zip-bomb refusal, prompt safety, citation verification** | nothing |
| Backend API | `backend/tests/api` | Auth and roles, devices, alerts, rules, retraining and versions, webhooks, platform behaviour, **assistant (conversations, streaming, tools, access control, prompt injection, failure handling), reports (all types, CSV/PDF, streaming, simulated marking, injection guard)** | PostgreSQL with pgvector, Redis |
| Live model | `backend/tests/live` | Real Ollama: grounded, cited answer; planted instruction not obeyed; off-topic question | Ollama + models, `RUN_LIVE_LLM=1` |
| Frontend | `frontend/tests` | Formatting, SSE parser, sign-in, rules screen, **Markdown renderer (no HTML injection), streamed answers and citations, retry/error/offline states, document upload validation, delete confirmation, reports page** | nothing (jsdom) |
| End-to-end | `e2e/` | The 13-step story in a real browser against the real API | Postgres + Redis, Chrome |

## Running

```bash
docker compose up -d postgres redis        # the API tests use real PostgreSQL (pgvector) and Redis

cd backend
npm run typecheck && npm run lint
npm test                                   # creates and drops its own database `iotmonitor_test` and uses Redis db 1

cd ../frontend
npm run typecheck && npm run lint && npm test

cd ../e2e && npm install
npx playwright test                        # uses database `iotmonitor_e2e`, Redis db 2, ports 4100/5174, installed Chrome
```

The tests never touch your data: the API tests use `iotmonitor_test` + Redis db 1, the E2E run recreates `iotmonitor_e2e` + Redis db 2 (the preparation script refuses any database name without "e2e").

### Live Ollama tests (optional, not in CI)

```bash
cd backend
RUN_LIVE_LLM=1 LLM_MODEL=<an installed chat model> npx vitest run --configLoader runner tests/live
```

Model output varies, so these assert safety properties (the answer is grounded and cited, a planted "ignore the user" instruction is not obeyed, an off-topic question yields no citations) rather than exact wording. They pass with `phi4-mini`; `qwen2.5:7b` did not fit the 6 GB GPU used for development. A passing live test on one small model is **not** proof of robustness against prompt injection.
To run the E2E scenario against a real model: `E2E_LIVE_LLM=1 npx playwright test` (the document-answer step then depends on model wording).

## The AI test double

CI has no Ollama or GPU, so tests select `LLM_PROVIDER=deterministic-test`: a **clearly labelled deterministic stand-in** (hashed bag-of-words embeddings; an answer assembled from the labelled sources it receives). It lets the suite verify what matters regardless of model quality — retrieval and access control, that private text never reaches a prompt, that source text stays inside markers, that invented citations are removed, and what happens when the model fails. It is refused when `NODE_ENV=production` and is never used by the running application unless configured on purpose. It says nothing about answer quality; that is what the live tests and manual review are for.

## What is deliberately not claimed

* Model accuracy: the synthetic-data AUC/precision/recall describe the generator; real-world accuracy has not been measured.
* Retrieval quality on real, large document sets beyond the calibration measurements in [RAG_ARCHITECTURE.md](RAG_ARCHITECTURE.md).
* Load/performance behaviour; only a 4,500-row streaming test and a 300-row PDF pagination test exist.
* The GitHub Actions workflow, until it has run there.

## Linting

`oxlint` (`npm run lint`) is used instead of ESLint: `typescript-eslint` does not yet support TypeScript 7, which this project uses. `tsc --noEmit` provides the type checks.

## Adding tests

* New API behaviour → `backend/tests/api/*.test.ts` using `bootstrap()`, `newUser()`, `newDevice()` from `tests/helpers.ts` (which installs the test AI provider).
* Anything that touches documents or prompts → also assert on `DeterministicTestProvider.lastMessages` to see exactly what a model would have received.
* UI → `frontend/tests/*.test.tsx` with a stubbed `fetch`; streamed answers can be faked with a `ReadableStream` body (see `assistant.test.tsx`).
