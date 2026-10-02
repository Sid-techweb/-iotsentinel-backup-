import { q } from '../db';
import { MetricKey } from '../ml/metrics';

export interface Rule {
  id: number;
  metric: MetricKey;
  operator: '>' | '<';
  threshold: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

let memo: { at: number; rows: Rule[] } | null = null;

export async function getRules(): Promise<Rule[]> {
  if (memo && Date.now() - memo.at < 5000) return memo.rows;
  const rows = await q<Rule>('SELECT * FROM rules ORDER BY metric, severity');
  memo = { at: Date.now(), rows };
  return rows;
}

export const invalidateRules = () => { memo = null; };

/** The prediction model forecasts the least severe enabled threshold of each metric. */
export async function predictionLimits(): Promise<Partial<Record<MetricKey, number>>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const r of await getRules()) {
    if (r.enabled && r.severity === 'warning') out[r.metric] = r.threshold;
  }
  for (const r of await getRules()) {
    if (r.enabled && out[r.metric] === undefined) out[r.metric] = r.threshold;
  }
  return out;
}
