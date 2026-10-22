# Deployment guide

## Requirements

* Docker with Compose v2 (or Node 22 + a local MongoDB 7, PostgreSQL 16 **with pgvector** and Redis for development).
* For the AI assistant: [Ollama](https://ollama.com) with a chat model and an embedding model. Everything else works without it.

## 1. Start the platform

```bash
cp .env.example .env        # then edit JWT_SECRET (see below)
docker compose up -d --build
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| REST API | http://localhost:4000/api |
| MongoDB | localhost:27017 (local only) - operational data |
| PostgreSQL | localhost:5433 (local only) - knowledge base and chats |

The first account you create becomes the administrator. The backend applies migrations, seeds a demo fleet (18 devices, 8 machine types) and starts the simulator unless `SIMULATOR=false`.
The PostgreSQL image is built locally from `docker/postgres/Dockerfile` (PostgreSQL 16 + pgvector 0.8.1). Existing data volumes keep working.

## 2. Ollama models for the assistant

Models are **not downloaded automatically**. Approximate sizes:

| Model | Role | Disk |
|---|---|---|
| `qwen2.5:7b` | chat (default) | ~4.7 GB |
| `qwen3-embedding:0.6b` | embeddings (default, 1024-dim) | ~0.6 GB |

```bash
ollama pull qwen2.5:7b
ollama pull qwen3-embedding:0.6b
```

Smaller machines: choose a smaller chat model and set `LLM_MODEL` (for example `phi4-mini:latest`, ~2.5 GB). A 6 GB GPU that also drives the desktop may not fit `qwen2.5:7b`; lower `LLM_NUM_CTX` or pick a smaller model.
Check what the backend sees at `GET /api/assistant/health` (or the banner on the assistant page).

### Reaching Ollama from the backend container

The Compose file points the backend at `http://host.docker.internal:11434`. Ollama listens on `127.0.0.1` by default, which containers cannot reach. Options:

1. **Run the backend outside Docker** (below) — it reaches `localhost:11434` directly.
2. Make Ollama listen on all interfaces (`OLLAMA_HOST=0.0.0.0`). This exposes Ollama to your network: only do this on a trusted network or behind a firewall rule that limits it to Docker.
3. Run Ollama in Compose: `docker compose --profile ollama up -d`, `docker compose exec ollama ollama pull <model>`, and set `OLLAMA_URL=http://ollama:11434` in `.env`. GPU use needs the NVIDIA container toolkit.

Without a reachable Ollama the app still works: the assistant says the model service is unavailable, uploads stay queued and index automatically later, and search falls back to keywords.

## Local development

```bash
docker compose up -d mongo postgres redis
cd backend  && npm install && npm run dev      # http://localhost:4000
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxies /api)
```

Set `LLM_MODEL=<installed model>` in the environment of the backend if you do not have the default.

## Configuration reference (environment)

| Variable | Default | Notes |
|---|---|---|
| `MONGO_URL` | `mongodb://iot:iot@localhost:27017/iotmonitor?authSource=admin` | Operational data |
| `DATABASE_URL` | `postgres://iot:iot@localhost:5433/iotmonitor` | Knowledge base and chats (pgvector) |
| `REDIS_URL` | compose value | |
| `MONGO_PASSWORD`, `POSTGRES_PASSWORD` | `iot` | Passwords for the two database containers (set in `.env`) |
| `JWT_SECRET` | generated once and kept in the data volume | Set explicitly for multi-instance deployments |
| `SIMULATOR` | `true` | Built-in demo devices |
| `CORS_ORIGIN` | `http://localhost:8080` | Dashboard origin |
| `TRUST_PROXY` | `1` | nginx is in front of the API |
| `TELEMETRY_RETENTION_DAYS`, `PREDICTION_HISTORY_DAYS` | 7, 30 | |
| `LLM_PROVIDER` | `ollama` | `deterministic-test` is for tests only and refused in production |
| `OLLAMA_URL`, `LLM_MODEL`, `EMBED_MODEL` | see above | |
| `LLM_NUM_CTX`, `LLM_TIMEOUT_MS`, `LLM_TEMPERATURE` | 4096, 180000, 0.2 | |
| `EMBED_KEEP_ALIVE` | `0` | Unload the embedding model right after use (good for small GPUs); `10m` on larger machines |
| `MAX_UPLOAD_MB`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `UPLOADS_PER_MIN` | 10, 1000, 150, 10 | |
| `RAG_TOP_K`, `RAG_MIN_SCORE`, `RAG_RELATIVE_MARGIN`, `RAG_CONTEXT_CHARS` | 6, 0.40, 0.20, 6000 | Re-calibrate when changing `EMBED_MODEL` |
| `ASSISTANT_MSG_PER_MIN`, `REPORTS_PER_MIN`, `API_RATE_PER_MIN` | 20, 20, 600 | |
| `REPORT_MAX_ROWS`, `REPORT_PDF_MAX_ROWS` | 500000, 1000 | |

Data volumes: `mongodata` (operational data), `pgdata` (knowledge base), `appdata` (uploaded documents and the generated secret), `modelsdata` (trained models). `docker compose down` keeps them; `down -v` deletes everything.

## Production notes

* Terminate HTTPS in front of nginx (a TLS proxy or load balancer). Cookies are not used; tokens travel in the `Authorization` header, so always use HTTPS in production.
* nginx is configured for streamed assistant answers (no buffering, 5-minute timeout), 12 MB uploads on `/api/knowledge`, and long-running report exports.
* Back up `mongodata`, `pgdata` and `appdata` together (documents on disk and their rows must stay in step; users and devices referenced by chats live in MongoDB). Example: `docker compose exec mongo mongodump -u iot -p <password> --authenticationDatabase admin --archive > mongo.archive` and `pg_dump` for PostgreSQL.
* Low-memory hosts: the containers have memory limits (`mem_limit`); PostgreSQL 1 GB, backend 1 GB.

## Upgrading

Pull the new code and `docker compose up -d --build`. PostgreSQL migrations run automatically and only apply what is new; MongoDB indexes are ensured at start-up. Take backups first if the data matters.

## Moving an existing installation to MongoDB

Installations created before the MongoDB split keep their operational data in PostgreSQL. To move it:

1. Back up: `pg_dump -Fc` of the old database.
2. Start MongoDB: `docker compose up -d mongo` (and keep PostgreSQL running).
3. Stop the old backend so no new readings are written during the copy.
4. Copy: `cd backend && npm run migrate:to-mongo` (add `-- --dry-run` first to see the row counts). Ids are preserved, so existing documents and chats still point at the right users and devices. It is idempotent: running it again does not duplicate anything.
5. Start the new backend. The first start applies PostgreSQL migration 004.
6. Check the dashboard, then (optionally, when you are satisfied) drop the old PostgreSQL tables yourself. The tool never deletes anything.

Telemetry older than `TELEMETRY_RETENTION_DAYS` is copied but MongoDB's TTL index removes it shortly afterwards.
