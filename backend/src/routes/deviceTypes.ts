import { Router } from 'express';
import { z } from 'zod';
import { col, nextId, toApi } from '../mongo';
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
  const [types, countRows, modelRows] = await Promise.all([
    getDeviceTypes(),
    col('devices').aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }]).toArray(),
    col('models').find({}, { projection: { source: 1, samples: 1, trainedAt: 1 } }).toArray(),
  ]);
  const counts = countRows.map((c) => ({ type: c._id as string, n: c.n as number }));
  const models = modelRows.map((m) => ({ scope: m._id as unknown as string, source: m.source, samples: m.samples, trainedAt: m.trainedAt }));
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
  const row = { _id: (await nextId('device_types')) as any, name: b.name, description: b.description, metrics: b.metrics, baselines, createdAt: new Date() };
  try { await col('device_types').insertOne(row); } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, `A machine type named "${b.name}" already exists`);
    throw e;
  }
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.create', 'device_type', row._id, { name: b.name, metrics: b.metrics });
  res.status(201).json(toApi(row));
}));

/** Change which signals a machine type reports (the name is fixed because devices reference it). */
deviceTypesRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ description: z.string().trim().max(200).optional(), metrics: metricList.optional() }).parse(req.body);
  const set: Record<string, unknown> = {};
  if (b.description !== undefined) set.description = b.description;
  if (b.metrics !== undefined) set.metrics = b.metrics;
  const id = Number(req.params.id);
  const row = Object.keys(set).length
    ? await col('device_types').findOneAndUpdate({ _id: id as any }, { $set: set }, { returnDocument: 'after' })
    : await col('device_types').findOne({ _id: id as any });
  if (!row) throw new HttpError(404, 'Machine type not found');
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.update', 'device_type', req.params.id, { changed: Object.keys(b) });
  res.json(toApi(row));
}));

deviceTypesRouter.delete('/:id', asyncH(async (req, res) => {
  const t = await col('device_types').findOne({ _id: Number(req.params.id) as any });
  if (!t) throw new HttpError(404, 'Machine type not found');
  const used = await col('devices').countDocuments({ type: t.name });
  if (used > 0) throw new HttpError(409, `${used} device(s) still use this machine type - move or remove them first`);
  await col('rules').deleteMany({ deviceType: t.name });
  await col('models').deleteOne({ _id: t.name as any });
  await col('device_types').deleteOne({ _id: t._id });
  forgetModel(t.name);
  invalidateRules();
  invalidateDeviceTypes();
  audit(ctxOf(req), 'device_type.delete', 'device_type', req.params.id, { name: t.name });
  res.status(204).end();
}));
