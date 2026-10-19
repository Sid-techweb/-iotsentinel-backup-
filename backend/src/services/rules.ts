import { q } from '../db';
import { MetricKey } from '../ml/metrics';

export interface Rule {
  id: number;
  metric: MetricKey;
  operator: '>' | '<';
  threshold: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
  /** null = the default rule for every machine type; otherwise an override for that type */
  deviceType: string | null;
}

let memo: { at: number; rows: Rule[] } | null = null;

/** Every rule row (defaults and per-type overrides). */
export async function getRules(): Promise<Rule[]> {
  if (memo && Date.now() - memo.at < 5000) return memo.rows;
  const rows = await q<Rule>('SELECT * FROM rules ORDER BY metric, severity DESC, device_type NULLS FIRST');
  memo = { at: Date.now(), rows };
  return rows;
}

export const invalidateRules = () => { memo = null; };

/**
 * The rules that actually apply to one machine type: for each metric + severity a
 * type-specific override wins over the default (even when the override is disabled).
 */
export function effectiveRules(all: Rule[], type: string | null): Rule[] {
  const chosen = new Map<string, Rule>();
  for (const r of all) {
    const key = `${r.metric}:${r.severity}`;
    if (r.deviceType === null) {
      if (!chosen.has(key)) chosen.set(key, r);
    } else if (type !== null && r.deviceType === type) {
      chosen.set(key, r);
    }
  }
  return [...chosen.values()];
}

export async function rulesForType(type: string | null): Promise<Rule[]> {
  return effectiveRules(await getRules(), type);
}

/** The prediction model forecasts the least severe enabled threshold of each metric. */
export async function predictionLimits(type: string | null = null): Promise<Partial<Record<MetricKey, number>>> {
  const rules = (await rulesForType(type)).filter((r) => r.enabled);
  const out: Partial<Record<MetricKey, number>> = {};
  for (const r of rules) if (r.severity === 'warning') out[r.metric] = r.threshold;
  for (const r of rules) if (out[r.metric] === undefined) out[r.metric] = r.threshold;
  return out;
}
