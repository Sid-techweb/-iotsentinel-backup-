import { extract, HORIZON, MIN_POINTS, WINDOW } from './features';
import { METRIC_KEYS, METRICS, MetricKey } from './metrics';
import { ALERT_PROB, modelFor, scoreFeatures } from './model';

export type Point = { ts: number } & Record<MetricKey, number | null>;
export type Limits = Partial<Record<MetricKey, number>>;
export type RiskLevel = 'low' | 'elevated' | 'high' | 'breached';

export interface FeatureContribution {
  name: string;
  value: number;        // the feature as computed from the recent readings
  standardized: number; // (value - training mean) / training std
  weight: number;       // the model's coefficient for this feature
  contribution: number; // weight x standardized: this feature's push on the log-odds (exact for a linear model)
}

/**
 * Everything needed to explain one prediction without guessing. Logistic regression is linear in
 * its (standardised) features, so the contributions below add up exactly to the model's log-odds.
 */
export interface Explanation {
  measure: 'threshold-breach';   // what the probability means - NOT the probability of equipment failure
  model: { scope: string; version: string; source: 'synthetic' | 'telemetry'; auc: number; trainedAt: string };
  threshold: number;
  direction: 'above' | 'below';  // which side of the threshold counts as a breach
  current: number;
  fittedLevel: number;           // trend-line value at the newest reading (noise removed)
  headroom: number;              // distance still left before the threshold, in the metric's unit (negative = beyond it)
  slopePerMin: number;
  noise: number;                 // residual standard deviation of the fit, in the metric's unit
  readingsUsed: number;
  horizonReadings: number;
  horizonSeconds: number;        // horizonReadings x the observed reading interval
  readingIntervalSeconds: number;
  features: FeatureContribution[];
  bias: number;
  logit: number;
  modelProbability: number;      // sigmoid(logit)
  adjusted: boolean;             // true when the sanity check lowered a high score
  adjustmentNote: string | null;
  linearEtaSeconds: number | null;
}

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
  explanation: Explanation;
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

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * points: oldest -> newest. limits: the warning-level threshold per metric.
 * type: the machine type, which selects its own model when one has been trained.
 */
export function predictFromSeries(points: Point[], limits: Limits, type: string | null = null): DevicePrediction {
  const model = modelFor(type);
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
    const modelProbability = scoreFeatures(model, ex.x);
    let probability = breached ? 1 : modelProbability;
    const { slope, last, resid } = ex.fit;

    let secondsToBreach: number | null = null;
    if (breached) secondsToBreach = 0;
    else if (slope > 1e-9 && probability >= 0.25) secondsToBreach = Math.max(dt, ((T - last) / slope) * dt);

    // Sanity check: a high score must agree with the linear ETA (breach within ~2x the horizon),
    // or the metric must already sit right at the limit. Otherwise it is only "elevated".
    let adjustmentNote: string | null = breached ? 'Already beyond the threshold, so the breach probability is fixed at 100 % (no model score is needed).' : null;
    if (!breached && probability >= ALERT_PROB) {
      const etaOk = secondsToBreach !== null ? secondsToBreach <= 2 * HORIZON * dt : ex.x[0] < 0.03;
      if (!etaOk) {
        probability = ALERT_PROB - 0.05;
        adjustmentNote = `The model scored ${(modelProbability * 100).toFixed(0)} % but the straight-line trend does not reach the threshold within about twice the horizon, so the risk is shown as elevated rather than high.`;
      }
    }

    const features: FeatureContribution[] = ex.x.map((value, i) => {
      const standardized = (value - model.mean[i]) / model.std[i];
      return { name: model.featureNames[i] ?? `feature ${i + 1}`, value, standardized, weight: model.weights[i], contribution: model.weights[i] * standardized };
    });
    const logit = model.bias + features.reduce((a, f) => a + f.contribution, 0);

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

    const explanation: Explanation = {
      measure: 'threshold-breach',
      model: { scope: model.scope, version: model.version, source: model.source, auc: model.evaluation.auc, trainedAt: model.trainedAt },
      threshold, direction: dir === 1 ? 'above' : 'below',
      current, fittedLevel: dir * last, headroom: T - last,
      slopePerMin: ((dir * slope) / dt) * 60, noise: resid, readingsUsed: vals.length,
      horizonReadings: HORIZON, horizonSeconds: HORIZON * dt, readingIntervalSeconds: dt,
      features, bias: model.bias, logit, modelProbability: sigmoid(logit),
      adjusted: !breached && probability !== modelProbability, adjustmentNote,
      linearEtaSeconds: slope > 1e-9 ? Math.max(0, ((T - last) / slope) * dt) : null,
    };

    metrics.push({
      metric: key, label, unit, current, threshold, probability,
      level: levelOf(probability, breached), breached, secondsToBreach,
      slopePerMin: ((dir * slope) / dt) * 60, forecast, explanation,
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
