import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { rateLimit } from '../middleware/rateLimit';
import { audit, ctxOf } from '../services/audit';
import { ALL_REPORTS, findReport, Filters, preview, streamCsv, streamPdf } from '../services/reports';
import { asyncH, HttpError } from '../util';

export const reportsRouter = Router();

const bool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');

const query = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  deviceId: z.string().uuid().optional(),
  machineType: z.string().trim().min(1).max(60).optional(),
  includeSimulated: bool.optional(),
});

function filters(req: Request): Filters {
  const p = query.parse(req.query);
  const to = p.to ?? new Date();
  const from = p.from ?? new Date(to.getTime() - 7 * 86_400_000);
  if (from >= to) throw new HttpError(400, 'The start of the period must be before its end.');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, 'The period can be at most one year.');
  return { from, to, deviceId: p.deviceId, machineType: p.machineType, includeSimulated: p.includeSimulated ?? true };
}

const viewer = (req: Request) => ({ id: req.user!.id, role: req.user!.role });
const limiter = rateLimit({ name: 'reports', max: config.reportsPerMinute, by: (r) => r.user?.id ?? r.ip ?? 'anon' });

reportsRouter.get('/', (_req, res) => {
  res.json(ALL_REPORTS.map((r) => ({ id: r.id, title: r.title, description: r.description, uses: r.uses, note: r.note ?? null, columns: r.columns.length, formats: ['json', 'csv', 'pdf'] })));
});

reportsRouter.get('/:id', limiter, asyncH(async (req, res) => {
  const def = findReport(String(req.params.id));
  if (!def) throw new HttpError(404, 'Unknown report');
  res.json(await preview(def, filters(req), viewer(req), 50));
}));

async function download(req: Request, res: Response, kind: 'csv' | 'pdf') {
  const def = findReport(String(req.params.id));
  if (!def) throw new HttpError(404, 'Unknown report');
  const f = filters(req);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${def.id}-${stamp}.${kind}`;
  res.setHeader('Content-Type', kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const signal = { aborted: false };
  res.on('close', () => { if (!res.writableEnded) signal.aborted = true; });
  try {
    const rows = kind === 'csv' ? await streamCsv(def, f, viewer(req), res, signal) : await streamPdf(def, f, viewer(req), res, signal);
    audit(ctxOf(req), 'report.export', 'report', def.id, { format: kind, rows, from: f.from.toISOString(), to: f.to.toISOString(), deviceId: f.deviceId, machineType: f.machineType, includeSimulated: f.includeSimulated });
    if (kind === 'csv') res.end();
  } catch (e) {
    // headers are already on the wire: the best we can do is stop, so a truncated file is not mistaken for a complete one
    console.error(`[reports] ${def.id} ${kind} failed`, e);
    if (!res.headersSent) throw e;
    res.destroy(e as Error);
  }
}

reportsRouter.get('/:id/csv', limiter, asyncH((req, res) => download(req, res, 'csv')));
reportsRouter.get('/:id/pdf', limiter, asyncH((req, res) => download(req, res, 'pdf')));
