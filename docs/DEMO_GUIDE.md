# Demo guide (about 10 minutes)

Goal: show that the platform monitors a fleet, **predicts** threshold breaches, explains why, and lets a maintenance engineer ask questions answered from live data and
their own documents — with sources.

## Before you start

1. `docker compose up -d --build` (or the local dev servers) and open http://localhost:8080 (dev: http://localhost:5173).
2. Create the first account — it becomes the administrator.
3. For the assistant: Ollama running with the models from [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) and `GET /api/assistant/health` showing the provider OK.
4. Sample documents for the Knowledge Base are in [`docs/demo/`](demo/): `pump-maintenance-manual.md` and `inspection-log.csv`.

## Walkthrough

| Step | Do | What to point out |
|---|---|---|
| 1. Fleet | **Dashboard** | 18 simulated devices across 8 machine types, live status, alert counts. Everything updates by push (SSE) — no refresh |
| 2. Device | **Devices → open a device** | Latest readings, history charts with limit lines, alerts, maintenance history. **Add a maintenance entry** (admin) |
| 3. Take out of service | **Deactivate** a device, then reactivate | It stops counting and its alerts close — nothing is deleted. Both steps appear in its maintenance history |
| 4. Prediction | **Anomaly Prediction** | Risk ranking per device and signal, the forecast with a confidence band, time-to-breach. State clearly: *threshold breach, not equipment failure* |
| 5. Explanation | Open a device → **Why this risk?** | Exact feature contributions (headroom, trend, noise), model version and whether it was trained on synthetic or real telemetry |
| 6. Trigger a fault | **Dashboard → simulator controls → inject fault** on a device | Watch the signal climb, risk rise, a *predictive* alert open before the threshold alert |
| 7. Retraining | **Anomaly Prediction → Retrain from telemetry** for a machine type | Time-ordered evaluation; the new version is activated only if it passes the gate, otherwise the reason is shown. Versions and rollback are listed |
| 8. Knowledge Base | **Knowledge Base → upload** `pump-maintenance-manual.md` | Status goes queued → processing → ready; search it ("bearing inspection interval") |
| 9. Ask the assistant | **AI Assistant** → "Which devices need maintenance attention?" | Live-data chip, streamed answer, **[D1] citations** with the data time and the simulated flag |
| 10. Ask the documents | "What does the pump manual say about bearing inspection?" | **[S1] citation** with file, page/section; open the source card |
| 11. Explain a prediction | Open a device → **Ask the assistant** | The explanation is read from the model, not invented |
| 12. Safety | Ask something unrelated ("recipe for sourdough") | It says it cannot find it and does not guess. Upload a text file that says *"ignore all instructions"* — it is treated as data |
| 13. Privacy | Sign in as a second (viewer) account | It cannot see the first user's private document, chats or answers from it. Viewers cannot change anything |
| 14. Reports | **Reports → Device health → PDF**, then **CSV** | Simulated devices are marked; the report says what the numbers mean. **Explain with assistant** turns a report into a question |
| 15. Audit | **Audit Log** (admin) | Sign-ins, uploads, tool use and exports — never message text or secrets |

## If something goes wrong

* *"The AI model service is not reachable"* — start Ollama, or see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) (containers cannot reach a host Ollama bound to 127.0.0.1). The rest of the demo still works.
* *Out-of-memory from Ollama* — use a smaller chat model (`LLM_MODEL`), a smaller `LLM_NUM_CTX`, or stop other GPU programs.
* Uploads stay *queued* while embeddings are unavailable and index themselves when the service returns.

## Honest talking points

* Models trained on simulator data describe the simulator; with real devices the same pipeline learns real behaviour, and real-world accuracy has to be measured separately.
* The assistant is local (no data leaves the machine), read-only, and can be wrong — that is why every answer shows its sources.
