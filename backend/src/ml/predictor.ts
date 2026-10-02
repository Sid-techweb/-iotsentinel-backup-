import { extract, HORIZON, MIN_POINTS, WINDOW } from './features';
import { METRIC_KEYS, METRICS, MetricKey } from './metrics';
import { ALERT_PROB, loadModel, scoreFeatures } from './model';

export interface Point { ts: number; temperature: number | null; cpu: number | null; memory: number | null; battery: number | null; signal: number | null }
export type Limits = Partial<Record<MetricKey, number>>;
export type RiskLevel = 'low' | 'elevated' | 'high' | 'breached';

export interface MetricForecast {
  metric: MetricKey;
  label: string;
  unit: string;
  current: number;
  threshold: number;
  probability: number;
  level: RiskLevel;
  breached: boolean;
  secondsToBreach: number | null;
  slopePerMin: number;
  forecast: { t: number; value: number; lo: number; hi: number }[]; // t = seconds ahead
}

export interface DevicePrediction {
  riskScore: number;
  level: RiskLevel;
  topMetric: MetricKey | null;
  secondsToBreach: number | null;
  sampleCount: number;
  metrics: MetricForecast[];
}

const levelOf = (p: number, breached: boolean): RiskLevel =>
  breached ? 'breached' : p >= ALERT_PROB ? 'high' : p >= 0.3 ? 'elevated' : 'low';

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** points: oldest -> newest. limits: the warning-level threshold per metric. */
export function predictFromSeries(points: Point[], limits: Limits): DevicePrediction {
  const model = loadModel();
  const win = points.slice(-WINDOW);
  const dt = Math.max(0.5, median(win.slice(1).map((p, i) => (p.ts - win[i].ts) / 1000)) || 2);
  const metrics: MetricForecast[] = [];

  for (const key of METRIC_KEYS) {
    const threshold = limits[key];
    if (threshold === undefined) continue;
    const vals = win.map((p) => p[key]).filter((v): v is number => v !== null);
    if (vals.length < MIN_POINTS) continue;

    const { dir, range, label, unit } = METRICS[key];
    const stress = vals.map((v) => dir * v);
    const T = dir * threshold;
    const current = vals[vals.length - 1];
    const ex = extract(stress, T, range)!;
    const breached = stress[stress.length - 1] >= T;
    let probability = breached ? 1 : scoreFeatures(model, ex.x);
    const { slope, last, resid } = ex.fit;

    let secondsToBreach: number | null = null;
    if (breached) secondsToBreach = 0;
    else if (slope > 1e-9 && probability >= 0.25) secondsToBreach = Math.max(dt, ((T - last) / slope) * dt);

    // Sanity check: a high score must agree with the linear ETA (breach within ~2x the horizon),
    // or the metric must already sit right at the limit. Otherwise it is only "elevated".
    if (!breached && probability >= ALERT_PROB) {
      const etaOk = secondsToBreach !== null ? secondsToBreach <= 2 * HORIZON * dt : ex.x[0] < 0.03;
      if (!etaOk) probability = ALERT_PROB - 0.05;
    }

    const forecast = [];
    for (let i = 0; i <= HORIZON; i++) {
      const centre = last + slope * i;
      const band = 1.96 * resid * Math.sqrt(1 + i / 8);
      forecast.push({
        t: Math.round(i * dt * 10) / 10,
        value: dir * centre,
        lo: dir * (dir === 1 ? centre - band : centre + band),
        hi: dir * (dir === 1 ? centre + band : centre - band),
      });
    }

    metrics.push({
      metric: key, label, unit, current, threshold, probability,
      level: levelOf(probability, breached), breached, secondsToBreach,
      slopePerMin: ((dir * slope) / dt) * 60, forecast,
    });
  }

  metrics.sort((a, b) => b.probability - a.probability);
  const top = metrics[0];
  return {
    riskScore: top ? top.probability : 0,
    level: top ? top.level : 'low',
    topMetric: top ? top.metric : null,
    secondsToBreach: top ? top.secondsToBreach : null,
    sampleCount: win.length,
    metrics,
  };
}
