import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
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
  const existing = await q1<{ id: number }>('SELECT id FROM rules WHERE metric=$1 AND severity=$2 AND device_type=$3', [b.metric, b.severity, b.deviceType]);
  const row = existing
    ? await q1('UPDATE rules SET threshold=COALESCE($2, threshold), enabled=COALESCE($3, enabled) WHERE id=$1 RETURNING *', [existing.id, b.threshold ?? null, b.enabled ?? null])
    : await q1(
      'INSERT INTO rules (metric, operator, threshold, severity, enabled, device_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [b.metric, base.operator, b.threshold ?? base.threshold, b.severity, b.enabled ?? base.enabled, b.deviceType],
    );
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.override', 'rule', (row as any).id, { deviceType: b.deviceType, metric: b.metric, severity: b.severity, threshold: (row as any).threshold, enabled: (row as any).enabled });
  res.json(row);
}));

rulesRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ threshold: z.number().finite().optional(), enabled: z.boolean().optional() }).parse(req.body);
  const rows = await q(
    'UPDATE rules SET threshold=COALESCE($2, threshold), enabled=COALESCE($3, enabled) WHERE id=$1 RETURNING *',
    [req.params.id, b.threshold ?? null, b.enabled ?? null],
  );
  if (!rows.length) throw new HttpError(404, 'Rule not found');
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.update', 'rule', req.params.id, b);
  res.json(rows[0]);
}));

/** Remove an override so the machine type falls back to the default limit. */
rulesRouter.delete('/:id', asyncH(async (req, res) => {
  const rows = await q('DELETE FROM rules WHERE id=$1 AND device_type IS NOT NULL RETURNING id', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Override not found (default rules cannot be deleted)');
  invalidateRules();
  publish('rules');
  audit(ctxOf(req), 'rule.override_reset', 'rule', req.params.id);
  res.status(204).end();
}));
