import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
import { forgetModel } from '../ml/model';
import { METRIC_KEYS } from '../ml/metrics';
import { getDeviceType, getDeviceTypes, invalidateDeviceTypes } from '../services/deviceTypes';
import { invalidateRules } from '../services/rules';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError } from '../util';

export const deviceTypesRouter = Router();

const metricList = z.array(z.enum(METRIC_KEYS)).min(1, 'Choose at least one signal').max(METRIC_KEYS.length)
  .transform((m) => [...new Set(m)]);

deviceTypesRouter.get('/', asyncH(async (_req, res) => {
  const [types, counts, models] = await Promise.all([
    getDeviceTypes(),
    q<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM devices GROUP BY type'),
    q<{ scope: string; source: string; samples: number; trainedAt: string }>('SELECT scope, source, samples, trained_at FROM models'),
  ]);
  res.json(types.map((t) => ({
    ...t,
    deviceCount: counts.find((c) => c.type === t.name)?.n ?? 0,
    model: models.find((m) => m.scope === t.name) ?? null,
  })));
}));

deviceTypesRouter.post('/', asyncH(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(40),
    description: z.string().trim().max(200).default(''),
    metrics: metricList,
    baselines: z.record(z.string(), z.number().finite()).default({}),
  }).parse(req.body);
  if (await getDeviceType(b.name)) throw new HttpError(409, `A machine type named "${b.name}" already exists`);
  const baselines = Object.fromEntries(Object.entries(b.baselines).filter(([k]) => (b.metrics as string[]).includes(k)));
  const row = await q1('INSERT INTO device_types (name, description, metrics, baselines) VALUES ($1,$2,$3,$4) RETURNING *', [b.name, b.description, b.metrics, JSON.stringify(baselines)]);
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.create', 'device_type', (row as any).id, { name: b.name, metrics: b.metrics });
  res.status(201).json(row);
}));

/** Change which signals a machine type reports (the name is fixed because devices reference it). */
deviceTypesRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ description: z.string().trim().max(200).optional(), metrics: metricList.optional() }).parse(req.body);
  const row = await q1(
    'UPDATE device_types SET description=COALESCE($2, description), metrics=COALESCE($3, metrics) WHERE id=$1 RETURNING *',
    [req.params.id, b.description ?? null, b.metrics ?? null],
  );
  if (!row) throw new HttpError(404, 'Machine type not found');
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.update', 'device_type', req.params.id, { changed: Object.keys(b) });
  res.json(row);
}));

deviceTypesRouter.delete('/:id', asyncH(async (req, res) => {
  const t = await q1<{ name: string }>('SELECT name FROM device_types WHERE id=$1', [req.params.id]);
  if (!t) throw new HttpError(404, 'Machine type not found');
  const used = await q1<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE type=$1', [t.name]);
  if (used && used.n > 0) throw new HttpError(409, `${used.n} device(s) still use this machine type - move or remove them first`);
  await q('DELETE FROM rules WHERE device_type=$1', [t.name]);
  await q('DELETE FROM models WHERE scope=$1', [t.name]);
  await q('DELETE FROM device_types WHERE id=$1', [req.params.id]);
  forgetModel(t.name);
  invalidateRules();
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.delete', 'device_type', req.params.id, { name: t.name });
  res.status(204).end();
}));
