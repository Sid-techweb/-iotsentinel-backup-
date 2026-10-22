import { col, nextId, toApiList } from '../mongo';
import { withDevice } from './deviceQueries';
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
    await col('prediction_history').insertOne({
      _id: (await nextId('prediction_history')) as any, deviceId, metric: f.metric, probability: f.probability, level: f.level,
      secondsToBreach: f.secondsToBreach, threshold: f.threshold, currentValue: f.current, slopePerMin: f.slopePerMin,
      modelScope: explanation.model.scope, modelVersion: explanation.model.version, modelSource: explanation.model.source,
      explanation: JSON.parse(JSON.stringify(explanation)), createdAt: new Date(),
    });
  }
}

export interface HistoryFilter { deviceId?: string; metric?: string; before?: number; limit?: number }

export async function listPredictionHistory(f: HistoryFilter) {
  const filter: Record<string, unknown> = {};
  if (f.deviceId) filter.deviceId = f.deviceId;
  if (f.metric) filter.metric = f.metric;
  if (f.before) filter._id = { $lt: f.before };
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const rows = toApiList(await col('prediction_history').find(filter).sort({ _id: -1 }).limit(limit).toArray());
  return withDevice(rows);
}
