import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { features, pool, q, q1 } from '../../db';
import { AIProviderError, getProvider } from '../ai/provider';
import { publish } from '../events';
import { chunkPages } from './chunk';
import { detectType, DocExt, extractText } from './extract';
import { storedPath } from './store';

const toVector = (v: number[]) => `[${v.join(',')}]`;
const BACKOFF_SECONDS = 15;

interface DocRow { id: string; source: 'upload' | 'system'; storedName: string; originalName: string; attempts: number }

/** Errors worth retrying later (the model is busy or not running) versus ones the file itself caused. */
const isTransient = (e: unknown) => e instanceof AIProviderError && (e.code === 'unavailable' || e.code === 'timeout' || e.code === 'bad_response' || e.code === 'model_missing');

/**
 * Ingestion of one document: read -> validate -> extract -> clean -> chunk -> embed -> store.
 * The previous chunks of a re-indexed document are only replaced once the new ones are ready.
 */
export async function processDocument(doc: DocRow) {
  const buffer = fs.readFileSync(storedPath(doc));
  const { ext } = detectType(doc.originalName, buffer); // re-validate the stored bytes, not just the upload request
  const extracted = await extractText(ext as DocExt, buffer);
  const chunks = chunkPages(extracted.pages, { size: config.chunkSize, overlap: config.chunkOverlap });
  if (chunks.length === 0) throw new Error('The document produced no indexable text.');

  const provider = getProvider();
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 32) {
    vectors.push(...(await provider.embed(chunks.slice(i, i + 32).map((c) => c.content), 'document')));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM kb_chunks WHERE document_id=$1', [doc.id]);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await client.query(
        `INSERT INTO kb_chunks (document_id, chunk_index, content, page, section, char_count, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)`,
        [doc.id, c.index, c.content, c.page, c.section, c.content.length, toVector(vectors[i]), provider.embedModel],
      );
    }
    await client.query(
      `UPDATE kb_documents SET status='ready', error=NULL, pages=$2, chunk_count=$3, embedding_model=$4, embedding_dim=$5, ingested_at=now(), updated_at=now() WHERE id=$1`,
      [doc.id, extracted.pageCount, chunks.length, provider.embedModel, vectors[0].length],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Take the next queued document (safe with several workers) and process it. Returns false when the queue is empty. */
export async function processNext(): Promise<boolean> {
  const doc = await q1<DocRow>(
    `UPDATE kb_documents SET status='processing', attempts=attempts+1, error=NULL, updated_at=now()
      WHERE id = (SELECT id FROM kb_documents
                   WHERE status='queued' AND updated_at <= now() - (attempts * $1 * interval '1 second')
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, source, stored_name, original_name, attempts`, [BACKOFF_SECONDS]);
  if (!doc) return false;
  publish('kb', { id: doc.id });
  try {
    await processDocument(doc);
    console.log(`[kb] indexed ${doc.originalName}`);
  } catch (e) {
    const message = (e as Error).message;
    const retry = isTransient(e) && doc.attempts < config.ingestMaxAttempts;
    await q('UPDATE kb_documents SET status=$2, error=$3, updated_at=now() WHERE id=$1',
      [doc.id, retry ? 'queued' : 'failed', retry ? `${message} (retry ${doc.attempts}/${config.ingestMaxAttempts})` : message]);
    console.warn(`[kb] ${doc.originalName}: ${retry ? 'will retry' : 'failed'} - ${message}`);
  }
  publish('kb', { id: doc.id });
  return true;
}

let running = false;
let again = false;

/** Process the queue until it is empty. Calls made while it is running are folded into the same run. */
export async function drainQueue() {
  if (!features.knowledgeBase) return;
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      while (await processNext()) { /* keep going */ }
    } while (again);
  } catch (e) {
    console.error('[kb] ingestion worker error', e);
  } finally {
    running = false;
  }
}

/** Fire-and-forget trigger used right after an upload. */
export const kickIngestion = () => { void drainQueue(); };

export function startIngestionWorker() {
  if (!features.knowledgeBase) return null;
  // a crash mid-ingestion leaves documents 'processing': put them back in the queue
  q(`UPDATE kb_documents SET status='queued', updated_at=now() WHERE status='processing'`).catch(() => undefined);
  kickIngestion();
  const timer = setInterval(kickIngestion, 10_000);
  timer.unref();
  return timer;
}

/**
 * Keep the application's own documentation (docs/*.md) in the knowledge base as shared, read-only
 * documents, so the assistant can answer questions about the project itself. Changed files are re-indexed.
 */
export async function syncSystemDocs(): Promise<{ added: number; updated: number; removed: number }> {
  const result = { added: 0, updated: 0, removed: 0 };
  if (!features.knowledgeBase || !fs.existsSync(config.docsDir)) return result;
  const files = fs.readdirSync(config.docsDir).filter((f) => f.toLowerCase().endsWith('.md'));

  for (const file of files) {
    const data = fs.readFileSync(path.join(config.docsDir, file));
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const title = (/^#\s+(.+)$/m.exec(data.toString('utf8'))?.[1] ?? file).trim().slice(0, 200);
    const existing = await q1<{ id: string; sha256: string }>(`SELECT id, sha256 FROM kb_documents WHERE source='system' AND original_name=$1`, [file]);
    try {
      if (!existing) {
        await q(
          `INSERT INTO kb_documents (owner_id, source, title, original_name, stored_name, mime, size_bytes, sha256, visibility, status)
           VALUES (NULL,'system',$1,$2,$3,'text/markdown',$4,$5,'shared','queued')`, [title, file, `system:${file}`, data.length, sha]);
        result.added++;
      } else if (existing.sha256 !== sha) {
        await q(`UPDATE kb_documents SET title=$2, sha256=$3, size_bytes=$4, status='queued', attempts=0, error=NULL, updated_at=now() WHERE id=$1`, [existing.id, title, sha, data.length]);
        result.updated++;
      }
    } catch (e) {
      console.warn(`[kb] could not register ${file}: ${(e as Error).message}`); // e.g. identical content already registered
    }
  }
  const gone = await q(`DELETE FROM kb_documents WHERE source='system' AND NOT (original_name = ANY($1::text[])) RETURNING id`, [files]);
  result.removed = gone.length;
  kickIngestion();
  return result;
}
