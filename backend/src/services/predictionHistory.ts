import { q } from '../db';
import { MetricForecast } from '../ml/predictor';
import { redis } from '../redis';

const MIN_PROBABILITY = 0.3;   // only record readings the model considers at least "elevated"
const MIN_GAP_SECONDS = 30;    // at most one snapshot per device and metric every 30 s

/**
 * Keep a trail of what the model predicted and why. Every row is a probability that a configured
 * threshold will be crossed - not a label that equipment failed - and carries the model version
 * and the full explanation so an alert can be reviewed later.
 */
export async function recordPredictions(deviceId: string, forecasts: MetricForecast[]) {
  for (const f of forecasts) {
    if (f.breached || f.probability < MIN_PROBABILITY) continue;
    const first = await redis.set(`ph:${deviceId}:${f.metric}`, '1', 'EX', MIN_GAP_SECONDS, 'NX');
    if (!first) continue;
    const { forecast: _curve, explanation, ...rest } = f;
    void _curve; void rest;
    await q(
      `INSERT INTO prediction_history (device_id, metric, probability, level, seconds_to_breach, threshold, current_value, slope_per_min,
                                       model_scope, model_version, model_source, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [deviceId, f.metric, f.probability, f.level, f.secondsToBreach, f.threshold, f.current, f.slopePerMin,
        explanation.model.scope, explanation.model.version, explanation.model.source, JSON.stringify(explanation)],
    );
  }
}

export interface HistoryFilter { deviceId?: string; metric?: string; before?: number; limit?: number }

export async function listPredictionHistory(f: HistoryFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.deviceId) { params.push(f.deviceId); where.push(`h.device_id = $${params.length}`); }
  if (f.metric) { params.push(f.metric); where.push(`h.metric = $${params.length}`); }
  if (f.before) { params.push(f.before); where.push(`h.id < $${params.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  return q(
    `SELECT h.id, h.device_id, d.name AS device_name, d.asset_no, d.type AS device_type, h.metric, h.probability, h.level, h.seconds_to_breach,
            h.threshold, h.current_value, h.slope_per_min, h.model_scope, h.model_version, h.model_source, h.explanation, h.created_at
       FROM prediction_history h JOIN devices d ON d.id = h.device_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC LIMIT ${limit}`, params);
}
