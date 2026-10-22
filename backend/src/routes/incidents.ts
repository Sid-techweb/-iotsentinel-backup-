import { Router } from 'express';
import { z } from 'zod';
import { col, toApi, toApiList } from '../mongo';
import { withDevice } from '../services/deviceQueries';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { createIncident } from '../services/incidents';
import { asyncH, HttpError, toCsv } from '../util';

export const incidentsRouter = Router();

async function listIncidents(query: Record<string, string | undefined>, limit: number) {
  const { status, severity } = query;
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (severity) filter.severity = severity;
  return withDevice(toApiList(await col('security_incidents').find(filter).sort({ createdAt: -1 }).limit(limit).toArray()));
}

incidentsRouter.get('/', asyncH(async (req, res) => {
  res.json(await listIncidents(req.query as Record<string, string | undefined>, 200));
}));

/** Incident report as a spreadsheet-friendly CSV (honours the same status/severity filters). */
incidentsRouter.get('/export.csv', asyncH(async (req, res) => {
  const rows = await listIncidents(req.query as Record<string, string | undefined>, 5000);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="security-incidents.csv"');
  res.send(toCsv(rows, [
    { key: 'id', header: 'ID' }, { key: 'createdAt', header: 'Reported' }, { key: 'severity', header: 'Severity' },
    { key: 'category', header: 'Category' }, { key: 'deviceName', header: 'Device' }, { key: 'description', header: 'Description' },
    { key: 'status', header: 'Status' }, { key: 'updatedAt', header: 'Last updated' },
  ]));
}));

incidentsRouter.get('/summary', asyncH(async (_req, res) => {
  const incidents = col('security_incidents');
  const [bySeverity, byCategory, byStatus, trend] = await Promise.all([
    incidents.aggregate([{ $match: { status: { $ne: 'resolved' } } }, { $group: { _id: '$severity', count: { $sum: 1 } } }]).toArray(),
    incidents.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
    incidents.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
    incidents.aggregate([
      { $match: { createdAt: { $gt: new Date(Date.now() - 24 * 3600_000) } } },
      { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'hour' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);
  res.json({
    bySeverity: bySeverity.map((r) => ({ severity: r._id, count: r.count })),
    byCategory: byCategory.map((r) => ({ category: r._id, count: r.count })),
    byStatus: byStatus.map((r) => ({ status: r._id, count: r.count })),
    trend: trend.map((r) => ({ hour: r._id, count: r.count })),
  });
}));

incidentsRouter.post('/', asyncH(async (req, res) => {
  const b = z.object({
    deviceId: z.string().uuid().nullable().optional(),
    category: z.string().trim().min(2).max(60),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    description: z.string().trim().min(3).max(400),
  }).parse(req.body);
  const created = await createIncident(b);
  audit(ctxOf(req), 'incident.create', 'incident', (created as any)?.id, { category: b.category, severity: b.severity });
  res.status(201).json(created);
}));

incidentsRouter.patch('/:id', asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'investigating', 'resolved']) }).parse(req.body);
  const row = await col('security_incidents').findOneAndUpdate({ _id: Number(req.params.id) as any }, { $set: { status, updatedAt: new Date() } }, { returnDocument: 'after' });
  if (!row) throw new HttpError(404, 'Incident not found');
  publish('incident', { id: row._id });
  audit(ctxOf(req), 'incident.status', 'incident', req.params.id, { status });
  res.json(toApi(row));
}));
