import { Router } from 'express';
import { z } from 'zod';
import { col, toApi, toApiList } from '../mongo';
import { withDevice } from '../services/deviceQueries';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError, toCsv } from '../util';

export const alertsRouter = Router();

async function listAlerts(query: Record<string, string | undefined>, limit: number) {
  const { status, severity, type, deviceId, rangeSec } = query;
  const filter: Record<string, unknown> = {};
  if (status === 'active') filter.status = { $ne: 'resolved' };
  else if (status) filter.status = status;
  if (severity) filter.severity = severity;
  if (type) filter.type = type;
  if (deviceId) filter.deviceId = deviceId;
  if (rangeSec) {
    const since = new Date(Date.now() - Number(rangeSec) * 1000);
    filter.$or = [{ status: { $ne: 'resolved' } }, { resolvedAt: { $gt: since } }];
  }
  const rows = await col('alerts').aggregate([
    { $match: filter },
    { $addFields: { isResolved: { $eq: ['$status', 'resolved'] } } }, // open alerts first, newest first inside each group
    { $sort: { isResolved: 1, createdAt: -1 } },
    { $limit: limit },
    { $project: { isResolved: 0 } },
  ]).toArray();
  return withDevice(toApiList(rows));
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
  const set: Record<string, unknown> = { status };
  if (status === 'resolved') set.resolvedAt = new Date();
  const row = await col('alerts').findOneAndUpdate({ _id: Number(req.params.id) as any }, { $set: set }, { returnDocument: 'after' });
  if (!row) throw new HttpError(404, 'Alert not found');
  publish('alert', { id: row._id });
  audit(ctxOf(req), 'alert.' + status, 'alert', req.params.id);
  res.json(toApi(row));
}));
