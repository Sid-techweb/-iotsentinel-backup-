import crypto from 'crypto';
import fs from 'fs';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { config } from '../config';
import { features, q, q1 } from '../db';
import { rateLimit } from '../middleware/rateLimit';
import { getProvider } from '../services/ai/provider';
import { audit, ctxOf } from '../services/audit';
import { publish } from '../services/events';
import { detectType, sanitizeFilename } from '../services/kb/extract';
import { kickIngestion, syncSystemDocs } from '../services/kb/ingest';
import {
  deleteDocument, getDocument, getEditableDocument, listDocuments, newStoredName, saveUpload, searchKnowledge, storedPath, Viewer,
} from '../services/kb/store';
import { asyncH, HttpError } from '../util';

export const knowledgeRouter = Router();

knowledgeRouter.use((_req: Request, _res: Response, next: NextFunction) => {
  if (!features.knowledgeBase) return next(new HttpError(503, 'The knowledge base is unavailable: the database has no pgvector extension. Use the provided PostgreSQL image (see docs/DEPLOYMENT_GUIDE.md).'));
  next();
});

const viewer = (req: Request): Viewer => ({ id: req.user!.id, role: req.user!.role });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 6, fieldSize: 2000 },
});

/** Service status: is the model provider reachable, which models, how many documents in each state. */
knowledgeRouter.get('/status', asyncH(async (_req, res) => {
  const [health, counts] = await Promise.all([
    getProvider().health().catch((e) => ({ ok: false, error: (e as Error).message })),
    q<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM kb_documents GROUP BY status'),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  res.json({
    enabled: true,
    provider: health,
    documents: { total: counts.reduce((n, c) => n + c.n, 0), ready: by.ready ?? 0, queued: by.queued ?? 0, processing: by.processing ?? 0, failed: by.failed ?? 0 },
    limits: { maxUploadMb: config.maxUploadBytes / 1024 / 1024, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap, types: ['pdf', 'docx', 'txt', 'md', 'csv'] },
  });
}));

knowledgeRouter.get('/', asyncH(async (req, res) => {
  const f = z.object({ q: z.string().max(100).optional(), status: z.enum(['queued', 'processing', 'ready', 'failed']).optional() }).parse(req.query);
  res.json(await listDocuments(viewer(req), f));
}));

/** Search across everything the user may read. Falls back to keyword search - and says so - if embeddings are unavailable. */
knowledgeRouter.get('/search', asyncH(async (req, res) => {
  const { q: query, limit } = z.object({ q: z.string().trim().min(2).max(300), limit: z.coerce.number().int().min(1).max(20).default(8) }).parse(req.query);
  const result = await searchKnowledge(viewer(req), query, { topK: limit, allowKeywordFallback: true });
  res.json({
    mode: result.mode,
    note: result.note ?? null,
    results: result.hits.map((h) => ({
      documentId: h.documentId, title: h.title, filename: h.filename, source: h.source, page: h.page, section: h.section,
      excerpt: h.content.length > 420 ? h.content.slice(0, 420) + '…' : h.content, score: h.score,
    })),
  });
}));

knowledgeRouter.post('/', rateLimit({ name: 'kb-upload', max: config.uploadsPerMinute, by: (r) => r.user?.id ?? r.ip ?? 'anon' }), upload.single('file'), asyncH(async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Attach a file in the "file" field.');
  const body = z.object({ visibility: z.enum(['private', 'shared']).default('private'), title: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  if (body.visibility === 'shared' && req.user!.role !== 'admin') throw new HttpError(403, 'Only administrators can share a document with everyone.');

  // multer reports the name as latin1; recover UTF-8 names, then reduce to a safe display name
  const display = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
  const { ext, mime } = detectType(display, file.buffer);
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const dup = await q1<{ id: string }>('SELECT id FROM kb_documents WHERE owner_id=$1 AND sha256=$2', [req.user!.id, sha256]);
  if (dup) return void res.status(409).json({ error: 'You have already uploaded this exact file.', documentId: dup.id });

  const storedName = newStoredName(ext);
  saveUpload(storedName, file.buffer);
  let row: { id: string } | undefined;
  try {
    row = await q1<{ id: string }>(
      `INSERT INTO kb_documents (owner_id, source, title, original_name, stored_name, mime, size_bytes, sha256, visibility, status)
       VALUES ($1,'upload',$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING id`,
      [req.user!.id, body.title || display.replace(/\.[^.]+$/, ''), display, storedName, mime, file.size, sha256, body.visibility]);
  } catch (e) {
    fs.rmSync(storedPath({ source: 'upload', storedName }), { force: true });
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'You have already uploaded this exact file.');
    throw e;
  }
  audit(ctxOf(req), 'kb.upload', 'document', row!.id, { name: display, bytes: file.size, type: ext, visibility: body.visibility });
  publish('kb', { id: row!.id });
  kickIngestion();
  res.status(202).json(await getDocument(viewer(req), row!.id));
}));

/** Re-read the project's own docs/*.md into the knowledge base (administrators). */
knowledgeRouter.post('/system/reindex', requireAdmin, asyncH(async (req, res) => {
  const result = await syncSystemDocs();
  audit(ctxOf(req), 'kb.system_reindex', 'document', null, result);
  res.json(result);
}));

knowledgeRouter.get('/:id', asyncH(async (req, res) => {
  const doc = await getDocument(viewer(req), String(req.params.id));
  const chunks = await q('SELECT chunk_index, page, section, char_count, left(content, 300) AS preview FROM kb_chunks WHERE document_id=$1 ORDER BY chunk_index LIMIT 12', [doc.id]);
  res.json({ ...doc, chunkPreview: chunks });
}));

knowledgeRouter.patch('/:id', asyncH(async (req, res) => {
  const doc = await getEditableDocument(viewer(req), String(req.params.id));
  const b = z.object({ title: z.string().trim().min(1).max(200).optional(), visibility: z.enum(['private', 'shared']).optional() }).parse(req.body);
  if (b.visibility === 'shared' && req.user!.role !== 'admin') throw new HttpError(403, 'Only administrators can share a document with everyone.');
  await q('UPDATE kb_documents SET title=COALESCE($2,title), visibility=COALESCE($3,visibility), updated_at=now() WHERE id=$1', [doc.id, b.title ?? null, b.visibility ?? null]);
  audit(ctxOf(req), 'kb.update', 'document', doc.id, { changed: Object.keys(b), visibility: b.visibility });
  publish('kb', { id: doc.id });
  res.json(await getDocument(viewer(req), doc.id));
}));

knowledgeRouter.delete('/:id', asyncH(async (req, res) => {
  const id = String(req.params.id);
  const doc = await getEditableDocument(viewer(req), id);
  await deleteDocument(viewer(req), id);
  audit(ctxOf(req), 'kb.delete', 'document', id, { name: doc.originalName });
  publish('kb', { id });
  res.status(204).end();
}));

/** Re-embed an already ingested document (for example after changing the embedding model). */
knowledgeRouter.post('/:id/reindex', asyncH(async (req, res) => {
  const doc = await getEditableDocument(viewer(req), String(req.params.id));
  await q(`UPDATE kb_documents SET status='queued', attempts=0, error=NULL, updated_at=now() WHERE id=$1`, [doc.id]);
  audit(ctxOf(req), 'kb.reindex', 'document', doc.id);
  publish('kb', { id: doc.id });
  kickIngestion();
  res.status(202).json(await getDocument(viewer(req), doc.id));
}));

/** Retry a document whose ingestion failed. */
knowledgeRouter.post('/:id/retry', asyncH(async (req, res) => {
  const doc = await getEditableDocument(viewer(req), String(req.params.id));
  if (doc.status !== 'failed') throw new HttpError(409, 'Only failed documents can be retried.');
  await q(`UPDATE kb_documents SET status='queued', attempts=0, error=NULL, updated_at=now() WHERE id=$1`, [doc.id]);
  audit(ctxOf(req), 'kb.retry', 'document', doc.id);
  publish('kb', { id: doc.id });
  kickIngestion();
  res.status(202).json(await getDocument(viewer(req), doc.id));
}));

/** Download the original file. Access is checked exactly like listing and retrieval. */
knowledgeRouter.get('/:id/download', asyncH(async (req, res) => {
  const doc = await getDocument(viewer(req), String(req.params.id));
  const stored = await q1<{ storedName: string }>('SELECT stored_name FROM kb_documents WHERE id=$1', [doc.id]);
  const file = storedPath({ source: doc.source, storedName: stored?.storedName, originalName: doc.originalName });
  if (!fs.existsSync(file)) throw new HttpError(404, 'The stored file is missing.');
  audit(ctxOf(req), 'kb.download', 'document', doc.id, { name: doc.originalName });
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  fs.createReadStream(file).pipe(res);
}));
