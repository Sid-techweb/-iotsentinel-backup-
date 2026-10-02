import { config } from '../config';
import { q } from '../db';
import { METRIC_KEYS, METRICS, MetricKey, Metrics } from '../ml/metrics';
import { ALERT_PROB } from '../ml/model';
import { keys, RECENT_MAX, redis } from '../redis';
import { clearAlerts, raiseAlert } from './alerts';
import { predictDevice } from './prediction';
import { getRules } from './rules';

export type MetricInput = Partial<Record<MetricKey, number | null>>;

const fmtEta = (s: number) => (s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)} min`);

/**
 * Single entry point for every heartbeat / telemetry reading, whether it comes from
 * the REST API (real device) or the built-in simulator:
 *   1. persist the reading            (PostgreSQL)
 *   2. refresh liveness + hot state   (Redis)
 *   3. evaluate threshold rules       -> threshold alerts
 *   4. run the anomaly predictor      -> predictive alerts (before the breach)
 *   5. recompute device status
 */
export async function ingest(deviceId: string, input: MetricInput = {}, ts = new Date()) {
  const m: Metrics = { temperature: null, cpu: null, memory: null, battery: null, signal: null };
  for (const k of METRIC_KEYS) m[k] = input[k] ?? null;
  const hasMetrics = METRIC_KEYS.some((k) => m[k] !== null);

  if (hasMetrics) {
    await q(
      `INSERT INTO telemetry (device_id, ts, temperature, cpu, memory, battery, signal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [deviceId, ts, m.temperature, m.cpu, m.memory, m.battery, m.signal],
    );
    const point = JSON.stringify({ ts: ts.getTime(), ...m });
    await redis
      .multi()
      .lpush(keys.recent(deviceId), point)
      .ltrim(keys.recent(deviceId), 0, RECENT_MAX - 1)
      .set(keys.latest(deviceId), point)
      .exec();
  }
  await redis.set(keys.hb(deviceId), '1', 'PX', config.offlineAfterMs);

  // a returning device clears its heartbeat alert
  await clearAlerts(deviceId, 'heartbeat');

  let degraded = false;

  // ---- rule-based threshold alerts ----
  if (hasMetrics) {
    const rules = await getRules();
    for (const key of METRIC_KEYS) {
      const v = m[key];
      if (v === null) continue;
      const { label, unit } = METRICS[key];
      const hit = rules.filter((r) => r.enabled && r.metric === key && (r.operator === '>' ? v > r.threshold : v < r.threshold));
      const worst = hit.find((r) => r.severity === 'critical') ?? hit[0];
      if (worst) {
        degraded = true;
        await raiseAlert({
          deviceId, type: 'threshold', severity: worst.severity, metric: key, value: v,
          message: `${label} ${v.toFixed(1)}${unit} is ${worst.operator === '>' ? 'above' : 'below'} the ${worst.severity} limit (${worst.threshold}${unit})`,
        });
      } else {
        await clearAlerts(deviceId, 'threshold', key);
      }
    }

    // ---- predictive alerts: warn BEFORE the threshold is crossed ----
    const { prediction } = await predictDevice(deviceId);
    for (const f of prediction.metrics) {
      if (f.breached) {
        await clearAlerts(deviceId, 'predictive', f.metric);
      } else if (f.probability >= ALERT_PROB) {
        await raiseAlert({
          deviceId, type: 'predictive', severity: 'warning', metric: f.metric, value: f.current,
          message: `${f.label} trending to ${f.threshold}${f.unit.trim() === '%' ? '%' : f.unit}${f.secondsToBreach ? ` in ~${fmtEta(f.secondsToBreach)}` : ''} (model confidence ${Math.round(f.probability * 100)}%)`,
        });
      } else if (f.probability < 0.3) {
        await clearAlerts(deviceId, 'predictive', f.metric);
      }
    }
  }

  await q(`UPDATE devices SET last_seen=$2, status=$3 WHERE id=$1`, [deviceId, ts, degraded ? 'degraded' : 'online']);
}
