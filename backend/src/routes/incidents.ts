import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { createIncident } from '../services/incidents';
import { asyncH, HttpError, toCsv } from '../util';

export const incidentsRouter = Router();

async function listIncidents(query: Record<string, string | undefined>, limit: number) {
  const { status, severity } = query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { params.push(status); where.push(`i.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`i.severity = $${params.length}`); }
  return q(
    `SELECT i.*, d.name AS device_name FROM security_incidents i LEFT JOIN devices d ON d.id=i.device_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC LIMIT ${limit}`, params);
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
  const [bySeverity, byCategory, byStatus, trend] = await Promise.all([
    q(`SELECT severity, count(*)::int AS count FROM security_incidents WHERE status <> 'resolved' GROUP BY severity`),
    q(`SELECT category, count(*)::int AS count FROM security_incidents GROUP BY category ORDER BY count DESC`),
    q(`SELECT status, count(*)::int AS count FROM security_incidents GROUP BY status`),
    q(`SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS count FROM security_incidents
       WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`),
  ]);
  res.json({ bySeverity, byCategory, byStatus, trend });
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
  const rows = await q('UPDATE security_incidents SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, status]);
  if (!rows.length) throw new HttpError(404, 'Incident not found');
  publish('incident', { id: rows[0].id });
  audit(ctxOf(req), 'incident.status', 'incident', req.params.id, { status });
  res.json(rows[0]);
}));
