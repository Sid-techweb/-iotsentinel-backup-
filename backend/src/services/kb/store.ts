import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { col } from '../../mongo';
import { config } from '../../config';
import { pool, q, q1 } from '../../db';
import { HttpError } from '../../util';
import { getProvider } from '../ai/provider';

export interface Viewer { id: string; role: 'admin' | 'viewer' }

/**
 * Who may read a document: its owner, anyone when it is shared (application documentation is always
 * shared), and administrators. This one predicate guards listing, search, retrieval for the
 * assistant and download, so the AI can never see a document the signed-in user could not open.
 */
export function accessPredicate(user: Viewer, params: unknown[], alias = 'd'): string {
  if (user.role === 'admin') return 'TRUE';
  params.push(user.id);
  return `(${alias}.owner_id = $${params.length} OR ${alias}.visibility = 'shared')`;
}

const DOC_COLUMNS = `d.id, d.owner_id, d.source, d.title, d.original_name, d.mime, d.size_bytes, d.sha256, d.visibility,
  d.status, d.error, d.attempts, d.pages, d.chunk_count, d.embedding_model, d.embedding_dim, d.created_at, d.updated_at, d.ingested_at`;

/** Owner names live with the users in MongoDB, so they are attached here rather than joined in SQL. */
async function withOwners<T extends { ownerId?: string | null }>(rows: T[]): Promise<(T & { ownerName: string | null })[]> {
  const ids = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
  const users = ids.length ? await col('users').find({ _id: { $in: ids as any[] } }, { projection: { name: 1 } }).toArray() : [];
  const names = new Map(users.map((u) => [u._id as unknown as string, u.name as string]));
  return rows.map((r) => ({ ...r, ownerName: r.ownerId ? names.get(r.ownerId) ?? null : null }));
}

const withEdit = (user: Viewer, d: any) => ({ ...d, canEdit: d.source === 'upload' && (user.role === 'admin' || d.ownerId === user.id) });

export async function listDocuments(user: Viewer, f: { q?: string; status?: string } = {}) {
  const params: unknown[] = [];
  const where = [accessPredicate(user, params)];
  if (f.status) { params.push(f.status); where.push(`d.status = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(d.title ILIKE $${params.length} OR d.original_name ILIKE $${params.length})`); }
  const rows = await q(`SELECT ${DOC_COLUMNS} FROM kb_documents d WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`, params);
  return (await withOwners(rows)).map((d) => withEdit(user, d));
}

export async function getDocument(user: Viewer, id: string) {
  const params: unknown[] = [id];
  const row = await q1(`SELECT ${DOC_COLUMNS} FROM kb_documents d WHERE d.id = $1 AND ${accessPredicate(user, params)}`, params).catch(() => undefined);
  if (!row) throw new HttpError(404, 'Document not found'); // never reveal that an inaccessible document exists
  return withEdit(user, (await withOwners([row]))[0]);
}

/** A document the user may change (owner or admin; system documentation is read-only here). */
export async function getEditableDocument(user: Viewer, id: string) {
  const doc = await getDocument(user, id);
  if (!doc.canEdit) throw new HttpError(403, doc.source === 'system' ? 'Application documentation is managed by the system' : 'Only the owner or an administrator can change this document');
  return doc;
}

export function newStoredName(ext: string) {
  return `${crypto.randomUUID()}.${ext}`;
}

export function saveUpload(storedName: string, data: Buffer) {
  fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o750 });
  fs.writeFileSync(path.join(config.uploadDir, storedName), data, { flag: 'wx', mode: 0o640 });
}

/** Absolute path of a stored document, checked to be inside its storage directory. */
export function storedPath(doc: { source: string; storedName?: string; originalName?: string }): string {
  const root = doc.source === 'system' ? config.docsDir : config.uploadDir;
  const name = doc.source === 'system' ? doc.originalName! : doc.storedName!;
  const full = path.resolve(root, path.basename(name));
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new HttpError(400, 'Invalid document path');
  return full;
}

export async function deleteDocument(user: Viewer, id: string) {
  await getEditableDocument(user, id);
  const row = await q1<{ storedName: string; source: string }>('DELETE FROM kb_documents WHERE id=$1 RETURNING stored_name, source', [id]);
  if (row && row.source === 'upload') fs.rmSync(path.join(config.uploadDir, path.basename(row.storedName)), { force: true });
}

/* ------------------------------------------------------------------ retrieval */

export interface ChunkHit {
  chunkId: number; documentId: string; title: string; filename: string; source: 'upload' | 'system';
  page: number | null; section: string | null; content: string;
  vectorScore: number | null; keywordRank: number | null; score: number;
}

const toVector = (v: number[]) => `[${v.join(',')}]`;
const RRF_K = 60;

export interface SearchResult { hits: ChunkHit[]; mode: 'hybrid' | 'keyword'; note?: string }

/**
 * Hybrid retrieval: nearest-neighbour search on the embeddings (pgvector, cosine) plus PostgreSQL full-text
 * ranking, merged with reciprocal rank fusion. Only chunks the user may access are ever considered.
 * With `allowKeywordFallback` a failure of the embedding model degrades to keyword search - and says so.
 */
export async function searchKnowledge(
  user: Viewer, query: string,
  opts: { topK?: number; allowKeywordFallback?: boolean; minScore?: number; maxChars?: number } = {},
): Promise<SearchResult> {
  const topK = opts.topK ?? config.ragTopK;
  const minScore = opts.minScore ?? config.ragMinScore;
  const text = query.trim().slice(0, 1000);
  if (!text) return { hits: [], mode: 'hybrid' };

  let vector: number[] | null = null;
  let note: string | undefined;
  try {
    [vector] = await getProvider().embed([text], 'query');
  } catch (e) {
    if (!opts.allowKeywordFallback) throw e;
    note = `Semantic search is unavailable (${(e as Error).message}); showing keyword matches only.`;
  }

  const client = await pool.connect();
  try {
    const byId = new Map<number, ChunkHit & { vRank?: number; kRank?: number }>();

    if (vector) {
      await client.query('BEGIN');
      // let the vector index keep scanning until enough rows survive the access filter
      await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      await client.query('SET LOCAL hnsw.ef_search = 100');
      const params: unknown[] = [toVector(vector)];
      const access = accessPredicate(user, params);
      const res = await client.query(
        `SELECT c.id, c.document_id, c.content, c.page, c.section, d.title, d.original_name, d.source, 1 - (c.embedding <=> $1::vector) AS score
           FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
          WHERE d.status = 'ready' AND ${access}
          ORDER BY c.embedding <=> $1::vector LIMIT 20`, params);
      await client.query('COMMIT');
      res.rows.forEach((r, i) => {
        byId.set(r.id, { chunkId: r.id, documentId: r.document_id, title: r.title, filename: r.original_name, source: r.source, page: r.page, section: r.section, content: r.content, vectorScore: Number(r.score), keywordRank: null, score: 0, vRank: i });
      });
    }

    const kparams: unknown[] = [text];
    const kaccess = accessPredicate(user, kparams);
    const kres = await client.query(
      `SELECT c.id, c.document_id, c.content, c.page, c.section, d.title, d.original_name, d.source, ts_rank_cd(c.tsv, plainto_tsquery('english', $1)) AS rank
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
        WHERE d.status = 'ready' AND c.tsv @@ plainto_tsquery('english', $1) AND ${kaccess}
        ORDER BY rank DESC LIMIT 20`, kparams);
    kres.rows.forEach((r, i) => {
      const hit = byId.get(r.id) ?? { chunkId: r.id, documentId: r.document_id, title: r.title, filename: r.original_name, source: r.source, page: r.page, section: r.section, content: r.content, vectorScore: null, keywordRank: null, score: 0 };
      hit.keywordRank = Number(r.rank);
      (hit as any).kRank = i;
      byId.set(r.id, hit);
    });

    // relevance gate: semantically close enough (absolutely, and relative to the best match) or an actual keyword match
    const best = Math.max(0, ...[...byId.values()].map((h) => h.vectorScore ?? 0));
    const floor = Math.max(minScore, best - config.ragRelativeMargin);
    const merged = [...byId.values()]
      .filter((h) => (h.vectorScore !== null && h.vectorScore >= floor) || (h.keywordRank !== null && h.keywordRank > 0))
      .map((h) => ({
        ...h,
        score: ((h as any).vRank !== undefined ? 1 / (RRF_K + (h as any).vRank + 1) : 0) + ((h as any).kRank !== undefined ? 1 / (RRF_K + (h as any).kRank + 1) : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const picked: ChunkHit[] = [];
    let chars = 0;
    for (const h of merged) {
      if (picked.length >= topK) break;
      if (opts.maxChars && chars + h.content.length > opts.maxChars && picked.length > 0) continue;
      chars += h.content.length;
      const { vRank: _v, kRank: _k, ...clean } = h as any;
      picked.push(clean);
    }
    return { hits: picked, mode: vector ? 'hybrid' : 'keyword', note };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
