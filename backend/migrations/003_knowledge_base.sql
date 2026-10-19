-- requires: vector
-- 003 knowledge base + AI assistant: documents, chunks with embeddings (pgvector) and conversations.
-- This migration needs the pgvector extension. Without it the migration is skipped and the platform
-- runs with the knowledge base and assistant disabled (see GET /api/assistant/health).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL for application documentation
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','system')),
  title TEXT NOT NULL,
  original_name TEXT NOT NULL,                              -- sanitized display name, never used as a path
  stored_name TEXT NOT NULL,                                -- random name on disk
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','failed')),
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  pages INT,
  chunk_count INT NOT NULL DEFAULT 0,
  embedding_model TEXT,
  embedding_dim INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingested_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kb_documents_owner ON kb_documents (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kb_documents_status ON kb_documents (status);
-- duplicate detection: the same bytes uploaded twice by the same owner (system documents are unique by hash)
CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_owner_hash ON kb_documents (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), sha256);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  page INT,
  section TEXT,
  char_count INT NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv ON kb_chunks USING gin (tsv);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_user ON chat_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  latency_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages (conversation_id, id);
