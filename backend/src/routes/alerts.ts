import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db';
import { asyncH, HttpError } from '../util';

export const alertsRouter = Router();

alertsRouter.get('/', asyncH(async (req, res) => {
  const { status, severity, type, deviceId, rangeSec } = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === 'active') where.push(`a.status <> 'resolved'`);
  else if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (type) { params.push(type); where.push(`a.type = $${params.length}`); }
  if (deviceId) { params.push(deviceId); where.push(`a.device_id = $${params.length}`); }
  if (rangeSec) { params.push(Number(rangeSec)); where.push(`(a.status <> 'resolved' OR a.resolved_at > now() - make_interval(secs => $${params.length}::float8))`); }
  res.json(await q(
    `SELECT a.*, d.name AS device_name, d.type AS device_type FROM alerts a JOIN devices d ON d.id=a.device_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (a.status='resolved'), a.created_at DESC LIMIT 200`, params));
}));

alertsRouter.patch('/:id', asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(['acknowledged', 'resolved']) }).parse(req.body);
  const rows = await q(
    `UPDATE alerts SET status=$2, resolved_at = CASE WHEN $2='resolved' THEN now() ELSE resolved_at END WHERE id=$1 RETURNING *`,
    [req.params.id, status],
  );
  if (!rows.length) throw new HttpError(404, 'Alert not found');
  res.json(rows[0]);
}));
