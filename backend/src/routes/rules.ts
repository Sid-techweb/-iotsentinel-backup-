import { Router } from 'express';
import { z } from 'zod';
import { col, nextId, toApi } from '../mongo';
import { METRIC_KEYS } from '../ml/metrics';
import { getDeviceType } from '../services/deviceTypes';
import { audit, ctxOf } from '../services/audit';
import { publish } from '../services/events';
import { effectiveRules, getRules, invalidateRules } from '../services/rules';
import { asyncH, HttpError } from '../util';

export const rulesRouter = Router();

/**
 * GET /api/rules                    -> the default rules (all machine types)
 * GET /api/rules?deviceType=<name>  -> the rules that apply to that machine type, restricted to the
 *                                      signals it reports; `inherited` is true when no override exists
 */
rulesRouter.get('/', asyncH(async (req, res) => {
  const all = await getRules();
  const typeName = typeof req.query.deviceType === 'string' ? req.query.deviceType : null;
  if (!typeName) return res.json(all.filter((r) => r.deviceType === null).map((r) => ({ ...r, inherited: false })));
  const type = await getDeviceType(typeName);
  if (!type) throw new HttpError(404, 'Unknown machine type');
  res.json(effectiveRules(all, typeName)
    .filter((r) => type.metrics.includes(r.metric))
    .map((r) => ({ ...r, inherited: r.deviceType === null })));
}));

const overrideSchema = z.object({
  deviceType: z.string().min(1),
  metric: z.enum(METRIC_KEYS),
  severity: z.enum(['warning', 'critical']),
  threshold: z.number().finite().optional(),
  enabled: z.boolean().optional(),
});

/** Create or update a machine type's own limit for one metric + severity. */
rulesRouter.put('/override', asyncH(async (req, res) => {
  const b = overrideSchema.parse(req.body);
  if (!(await getDeviceType(b.deviceType))) throw new HttpError(404, 'Unknown machine type');
  const base = (await getRules()).find((r) => r.deviceType === null && r.metric === b.metric && r.severity === b.severity);
  if (!base) throw new HttpError(404, 'No default rule exists for that metric and severity');
  const existing = await col('rules').findOne({ metric: b.metric, severity: b.severity, deviceType: b.deviceType });
  let row: any;
  if (existing) {
    const set: Record<string, unknown> = {};
    if (b.threshold !== undefined) set.threshold = b.threshold;
    if (b.enabled !== undefined) set.enabled = b.enabled;
    row = Object.keys(set).length ? await col('rules').findOneAndUpdate({ _id: existing._id }, { $set: set }, { returnDocument: 'after' }) : existing;
  } else {
    row = { _id: await nextId('rules'), metric: b.metric, operator: base.operator, threshold: b.threshold ?? base.threshold, severity: b.severity, enabled: b.enabled ?? base.enabled, deviceType: b.deviceType };
    await col('rules').insertOne(row);
  }
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.override', 'rule', row._id, { deviceType: b.deviceType, metric: b.metric, severity: b.severity, threshold: row.threshold, enabled: row.enabled });
  res.json(toApi(row));
}));

rulesRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ threshold: z.number().finite().optional(), enabled: z.boolean().optional() }).parse(req.body);
  const id = Number(req.params.id);
  const set: Record<string, unknown> = {};
  if (b.threshold !== undefined) set.threshold = b.threshold;
  if (b.enabled !== undefined) set.enabled = b.enabled;
  const row = Object.keys(set).length
    ? await col('rules').findOneAndUpdate({ _id: id as any }, { $set: set }, { returnDocument: 'after' })
    : await col('rules').findOne({ _id: id as any });
  if (!row) throw new HttpError(404, 'Rule not found');
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.update', 'rule', req.params.id, b);
  res.json(toApi(row));
}));

/** Remove an override so the machine type falls back to the default limit. */
rulesRouter.delete('/:id', asyncH(async (req, res) => {
  const r = await col('rules').deleteOne({ _id: Number(req.params.id) as any, deviceType: { $ne: null } });
  if (!r.deletedCount) throw new HttpError(404, 'Override not found (default rules cannot be deleted)');
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.override_reset', 'rule', req.params.id);
  res.status(204).end();
}));
