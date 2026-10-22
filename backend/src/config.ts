import crypto from 'crypto';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const simIntervalMs = Number(process.env.SIM_INTERVAL_MS ?? 2000);
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : fallback;
};
const str = (name: string, fallback: string) => (process.env[name] ? process.env[name]! : fallback);

const dataDir = path.resolve(str('DATA_DIR', path.join(process.cwd(), 'data')));

/**
 * The token-signing secret comes from JWT_SECRET. When it is not set, a strong random secret is
 * generated once and kept in the data directory (mode 0600), so nothing is hard-coded and
 * sessions survive restarts.
 */
function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, 'jwt-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* not created yet */ }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: num('PORT', 4000),
  databaseUrl: str('DATABASE_URL', 'postgres://iot:iot@localhost:5433/iotmonitor'),
  // PostgreSQL (databaseUrl) now holds only the knowledge base / assistant; everything else is in MongoDB.
  mongoUrl: str('MONGO_URL', 'mongodb://iot:iot@localhost:27017/iotmonitor?authSource=admin'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  simulator: (process.env.SIMULATOR ?? 'true') === 'true',
  simIntervalMs,
  // A device is declared offline when no heartbeat arrived for this long.
  offlineAfterMs: num('OFFLINE_AFTER_MS', simIntervalMs * 6),
  dataDir,
  jwtSecret: resolveJwtSecret(),
  retentionDays: num('TELEMETRY_RETENTION_DAYS', 7),
  predictionHistoryDays: num('PREDICTION_HISTORY_DAYS', 30),
  corsOrigin: str('CORS_ORIGIN', '*'),
  // webhooks may not target private networks unless explicitly allowed (local development / tests)
  allowPrivateWebhooks: (process.env.ALLOW_PRIVATE_WEBHOOKS ?? 'false') === 'true',
  rateLimit: (process.env.RATE_LIMIT ?? 'true') === 'true',
  apiRequestsPerMinute: num('API_RATE_PER_MIN', 600),
  deviceRequestsPerMinute: num('DEVICE_RATE_PER_MIN', 300),
  // number of reverse proxies in front of the API (nginx = 1) so req.ip is the real client
  trustProxy: num('TRUST_PROXY', 1),

  /* ------------------------------------------------------------ knowledge base */
  uploadDir: path.resolve(str('UPLOAD_DIR', path.join(dataDir, 'uploads'))),
  docsDir: path.resolve(str('DOCS_DIR', path.join(process.cwd(), '..', 'docs'))),
  maxUploadBytes: num('MAX_UPLOAD_MB', 10) * 1024 * 1024,
  chunkSize: num('CHUNK_SIZE', 1000),       // characters per chunk
  chunkOverlap: num('CHUNK_OVERLAP', 150),  // characters shared between neighbouring chunks
  ingestMaxAttempts: num('INGEST_MAX_ATTEMPTS', 3),

  /* ------------------------------------------------------------ AI assistant */
  // 'ollama' is the real provider. 'deterministic-test' exists only for automated tests and CI,
  // where no GPU/Ollama is available; it is refused when NODE_ENV=production.
  llmProvider: str('LLM_PROVIDER', 'ollama'),
  ollamaUrl: str('OLLAMA_URL', 'http://localhost:11434').replace(/\/+$/, ''),
  llmModel: str('LLM_MODEL', 'qwen2.5:7b'),
  embedModel: str('EMBED_MODEL', 'qwen3-embedding:0.6b'),
  embedDim: num('EMBED_DIM', 1024),   // must match the vector(N) column created by migration 003
  // Some embedding models want a task prefix: e.g. nomic-embed-text uses "search_document: " / "search_query: ".
  embedDocPrefix: process.env.EMBED_DOC_PREFIX ?? '',
  embedQueryPrefix: process.env.EMBED_QUERY_PREFIX
    ?? (str('EMBED_MODEL', 'qwen3-embedding:0.6b').startsWith('qwen3-embedding')
      ? 'Instruct: Given a question, retrieve the passages that answer it\nQuery: '
      : ''),
  llmTimeoutMs: num('LLM_TIMEOUT_MS', 180_000),
  embedTimeoutMs: num('EMBED_TIMEOUT_MS', 60_000),
  llmNumCtx: num('LLM_NUM_CTX', 4096),
  // how long Ollama keeps the embedding model in memory after use. '0' unloads it at once so a small GPU
  // (6 GB) has room for the chat model; use e.g. '10m' on larger machines to skip the reload.
  embedKeepAlive: str('EMBED_KEEP_ALIVE', '0'),
  llmTemperature: num('LLM_TEMPERATURE', 0.2),
  ragTopK: num('RAG_TOP_K', 6),
  // Minimum cosine similarity for a chunk to count as relevant. Measured with qwen3-embedding:0.6b: unrelated
  // questions score 0.30-0.35 against any document, genuinely related ones 0.45-0.80. Re-calibrate when changing
  // EMBED_MODEL (see docs/RAG_ARCHITECTURE.md).
  ragMinScore: num('RAG_MIN_SCORE', 0.40),
  ragRelativeMargin: num('RAG_RELATIVE_MARGIN', 0.20), // ...and within this distance of the best match, so one strong hit is not diluted by weak ones
  ragContextChars: num('RAG_CONTEXT_CHARS', 6000), // hard cap on retrieved document text per answer
  toolMaxRows: num('ASSISTANT_TOOL_MAX_ROWS', 25),
  assistantMessagesPerMinute: num('ASSISTANT_MSG_PER_MIN', 20),
  uploadsPerMinute: num('UPLOADS_PER_MIN', 10),
  reportMaxRows: num('REPORT_MAX_ROWS', 500_000),       // hard ceiling for one CSV export
  reportPdfMaxRows: num('REPORT_PDF_MAX_ROWS', 1000),    // PDFs are for reading; the CSV carries the complete data
  reportsPerMinute: num('REPORTS_PER_MIN', 20),
};

export type Config = typeof config;
