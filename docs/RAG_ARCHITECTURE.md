# RAG architecture (Knowledge Base + AI Maintenance Assistant)

## Goals and limits

The assistant answers maintenance questions from two sources and always shows which one: **live platform data** (read through fixed
tools) and **documents** users uploaded (manuals, SOPs, reports). It does not guess: with no relevant source it says so without calling the model.
It is **read-only** — it cannot change devices, rules, alerts or any record.

## Models and provider abstraction

`LLMProvider` (`backend/src/services/ai/provider.ts`) has `health()`, `embed()` and streaming `chat()`. The real implementation talks to a
local **Ollama** (`/api/embed`, `/api/chat`). Defaults: chat `qwen2.5:7b`, embeddings `qwen3-embedding:0.6b` (1024 dimensions, matching the
`vector(1024)` column). Failures become structured `AIProviderError` codes (`unavailable`, `model_missing`, `timeout`, `dimension_mismatch`, ...) that the UI explains.

`LLM_PROVIDER=deterministic-test` selects a **labelled test double** (hashed bag-of-words embeddings; an "answer" assembled from the sources it
was given). It exists only so tests/CI without Ollama or a GPU can exercise retrieval, citation and security code paths. It is refused when `NODE_ENV=production`.

## Ingestion pipeline

1. **Upload** (`POST /api/knowledge`, multer memory storage, size limit, per-user rate limit). Extension **and content** are validated: PDF header, DOCX ZIP structure
   with a central-directory **zip-bomb check**, text must be valid UTF-8 with no binary bytes. Filenames are reduced to a safe display name; files are stored under random names.
2. **Duplicate guard** — the same bytes by the same owner are rejected (409) via a SHA-256 unique index.
3. **Queue** — a row with `status=queued`; a worker claims rows with `FOR UPDATE SKIP LOCKED`, so several API instances can share the work. Transient failures retry with back-off; permanent ones become `failed` with a readable error. Documents stuck `processing` after a crash are re-queued at start-up.
4. **Extract** — PDF per page (pdfjs), DOCX (mammoth), CSV rows rendered as `column: value` lines, TXT/MD as text. Scanned/image-only PDFs yield "no text" (no OCR).
5. **Clean** — control and bidi-override characters removed, whitespace normalised.
6. **Chunk** — about 1000 characters with 150 overlap, preferring paragraph → sentence → word boundaries; each chunk keeps its page and Markdown heading.
7. **Embed & store** — batches go to the embedding model; vectors, text and a generated `tsvector` are stored. The embedding model name and dimension are recorded per document so a model change can be re-indexed.

The project's own `docs/*.md` are indexed as **shared, read-only system documents** at start-up, so the assistant can explain the platform itself.

## Retrieval (hybrid, access-controlled)

* **Vector search** — pgvector HNSW index, cosine distance (`hnsw.iterative_scan=relaxed_order` so the access filter cannot starve the result).
* **Keyword search** — PostgreSQL full-text (`GIN` on `tsvector`).
* **Fusion** — reciprocal rank fusion (K = 60) of both ranked lists.
* **Relevance gate** — a chunk must reach cosine ≥ `RAG_MIN_SCORE` (0.40) *and* be within `RAG_RELATIVE_MARGIN` (0.20) of the best match, or be a real keyword match. Calibrated on `qwen3-embedding:0.6b`: unrelated questions score 0.30–0.35 against any document, genuinely related ones 0.45–0.80. **Re-calibrate when changing `EMBED_MODEL`.**
* **Access control** — one predicate (owner, or `shared`, or administrator) is used by list, search, download **and retrieval**; the SQL applies it before ranking, so another user's private text can never reach a prompt. An inaccessible document returns 404, never 403.
* Top `RAG_TOP_K` (6) chunks, capped at `RAG_CONTEXT_CHARS` (6000) characters.

Pure live-data questions ("how many devices are online?") skip document retrieval unless the wording asks for written guidance.

## Live-data tools

A **deterministic rule-based planner** (`router.ts`) maps the question to at most four tools; the model never picks tools or arguments. Tools
(`tools.ts`): `fleet_status`, `device_profile`, `telemetry_history`, `top_risk`, `explain_prediction`, `anomaly_history`, `maintenance_history`,
`maintenance_attention`, `highest_metric`, `alerts_summary`, `breaches_by_type`, `model_info`. Each runs fixed parameterised SQL (no LLM-generated SQL), has a time-out, returns bounded rows, is
audited (`assistant.tool`) and marks simulated devices. Device references resolve by name, asset number, UUID, or the conversation's selected device.

## Prompt construction and prompt-injection resistance

* The **system prompt** is a constant; no document or database text is ever placed in it.
* Every source is rendered as `[S1] Document "title" (file, page N, section "X"):` / `[D1] Live data - title (as of …):` followed by `<<<BEGIN … <<<END`.
* Source text is sanitised first: control characters removed, fake `<<<BEGIN/END` markers and fake `[S#]/[D#]` citations neutralised.
* The prompt instructs the model to treat sources as data, never follow instructions inside them, cite every claim, and say when the sources do not contain the answer.
* The prompt is fitted to a context budget (live facts are truncated before documents are dropped, and `truncated` is reported).

## Citations

After generation `finalizeAnswer` compares citation markers with the sources actually supplied: unknown ids are removed and reported (`invalidCitations`),
cited sources are flagged, an answer citing nothing is flagged `uncited`. The UI shows each source (document, page, section, or live-data timestamp and simulated flag) and highlights the one a citation chip points to.

## Conversations

`chat_conversations` / `chat_messages` store history, sources, tool calls, model and latency per answer. Conversations are strictly owner-only (404 for everyone else, administrators included). Only completed turns feed later prompts; one generation per conversation at a time (Redis lock); 20 messages/min per user; transcripts export as Markdown or JSON.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Ollama not running | Chat returns a clear error and offers Retry; uploads stay queued and index when it returns; search falls back to keyword with a note |
| Model not installed | Health shows which model and the `ollama pull` command |
| Wrong embedding dimension | `dimension_mismatch` error before anything is stored |
| Client stops generation | Request is aborted; the partial answer is saved marked as stopped |
| Nothing relevant found | A fixed "I couldn't find that" reply; the model is not called |

## Hardware note

`qwen2.5:7b` needs roughly 5 GB of GPU memory plus the context cache. On a 6 GB GPU that is shared with the desktop it can fail with an out-of-memory error; use a smaller chat model (set `LLM_MODEL`), lower `LLM_NUM_CTX`, or keep `EMBED_KEEP_ALIVE=0` (default) so the embedding model is unloaded between uses.
