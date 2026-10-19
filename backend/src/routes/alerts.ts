import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError, toCsv } from '../util';

export const alertsRouter = Router();

async function listAlerts(query: Record<string, string | undefined>, limit: number) {
  const { status, severity, type, deviceId, rangeSec } = query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === 'active') where.push(`a.status <> 'resolved'`);
  else if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (type) { params.push(type); where.push(`a.type = $${params.length}`); }
  if (deviceId) { params.push(deviceId); where.push(`a.device_id = $${params.length}`); }
  if (rangeSec) { params.push(Number(rangeSec)); where.push(`(a.status <> 'resolved' OR a.resolved_at > now() - make_interval(secs => $${params.length}::float8))`); }
  return q(
    `SELECT a.*, d.name AS device_name, d.type AS device_type FROM alerts a JOIN devices d ON d.id=a.device_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (a.status='resolved'), a.created_at DESC LIMIT ${limit}`, params);
}

alertsRouter.get('/', asyncH(async (req, res) => {
  res.json(await listAlerts(req.query as Record<string, string | undefined>, 200));
}));

alertsRouter.get('/export.csv', asyncH(async (req, res) => {
  const rows = await listAlerts(req.query as Record<string, string | undefined>, 5000);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="alerts.csv"');
  res.send(toCsv(rows, [
    { key: 'id', header: 'ID' }, { key: 'createdAt', header: 'Raised' }, { key: 'severity', header: 'Severity' },
    { key: 'type', header: 'Type' }, { key: 'deviceName', header: 'Device' }, { key: 'metric', header: 'Metric' },
    { key: 'message', header: 'Message' }, { key: 'status', header: 'Status' }, { key: 'resolvedAt', header: 'Resolved' },
  ]));
}));

alertsRouter.patch('/:id', asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(['acknowledged', 'resolved']) }).parse(req.body);
  const rows = await q(
    `UPDATE alerts SET status=$2, resolved_at = CASE WHEN $2='resolved' THEN now() ELSE resolved_at END WHERE id=$1 RETURNING *`,
    [req.params.id, status],
  );
  if (!rows.length) throw new HttpError(404, 'Alert not found');
  publish('alert', { id: rows[0].id });
  audit(ctxOf(req), 'alert.' + status, 'alert', req.params.id);
  res.json(rows[0]);
}));
