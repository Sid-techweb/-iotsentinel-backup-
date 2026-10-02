import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db';
import { createIncident } from '../services/incidents';
import { asyncH, HttpError } from '../util';

export const incidentsRouter = Router();

incidentsRouter.get('/', asyncH(async (req, res) => {
  const { status, severity } = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { params.push(status); where.push(`i.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`i.severity = $${params.length}`); }
  res.json(await q(
    `SELECT i.*, d.name AS device_name FROM security_incidents i LEFT JOIN devices d ON d.id=i.device_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC LIMIT 200`, params));
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
  res.status(201).json(await createIncident(b));
}));

incidentsRouter.patch('/:id', asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(['open', 'investigating', 'resolved']) }).parse(req.body);
  const rows = await q('UPDATE security_incidents SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, status]);
  if (!rows.length) throw new HttpError(404, 'Incident not found');
  res.json(rows[0]);
}));
