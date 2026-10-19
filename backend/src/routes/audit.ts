import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { listAudit } from '../services/audit';
import { asyncH, toCsv } from '../util';

export const auditRouter = Router();
auditRouter.use(requireAdmin);

const query = z.object({
  action: z.string().max(60).optional(),
  userId: z.string().uuid().optional(),
  entity: z.string().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

auditRouter.get('/', asyncH(async (req, res) => {
  res.json(await listAudit(query.parse(req.query)));
}));

auditRouter.get('/export.csv', asyncH(async (req, res) => {
  const rows = await listAudit({ ...query.parse(req.query), limit: 5000 });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(toCsv(rows.map((r: any) => ({ ...r, details: JSON.stringify(r.details) })), [
    { key: 'id', header: 'ID' }, { key: 'createdAt', header: 'Time' }, { key: 'userEmail', header: 'User' },
    { key: 'action', header: 'Action' }, { key: 'entity', header: 'Entity' }, { key: 'entityId', header: 'Entity ID' },
    { key: 'ip', header: 'IP' }, { key: 'details', header: 'Details' },
  ]));
}));
