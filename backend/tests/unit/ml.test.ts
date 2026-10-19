import { describe, expect, it } from 'vitest';
import { extract, HORIZON, linFit, MIN_POINTS, WINDOW } from '../../src/ml/features';
import { ALERT_PROB, auc, evaluate, fitLogistic, forgetModel, LabelledSample, loadModel, modelFor, registerModel, scoreFeatures, trainModel } from '../../src/ml/model';
import { Point, predictFromSeries } from '../../src/ml/predictor';
import { emptyMetrics } from '../../src/ml/metrics';
import { windowsFrom } from '../../src/services/retrain';

const series = (values: number[], key: 'temperature' | 'battery' = 'temperature', dtMs = 2000): Point[] =>
  values.map((v, i) => ({ ...emptyMetrics(), ts: 1_000_000 + i * dtMs, [key]: v }) as Point);

describe('feature extraction', () => {
  it('recovers slope and level of a straight line exactly', () => {
    const fit = linFit([10, 12, 14, 16, 18, 20]);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.last).toBeCloseTo(20, 10);
    expect(fit.resid).toBeCloseTo(0, 10);
  });

  it('needs a minimum number of readings', () => {
    expect(extract(Array(MIN_POINTS - 1).fill(1), 10, 10)).toBeNull();
    expect(extract(Array(MIN_POINTS).fill(1), 10, 10)).not.toBeNull();
  });

  it('reports headroom and a positive projected movement for a rising series', () => {
    const rising = Array.from({ length: WINDOW }, (_, i) => 40 + i); // 40..59
    const { x } = extract(rising, 70, 50)!;
    expect(x[0]).toBeCloseTo((70 - 59) / 50, 5); // headroom
    expect(x[1]).toBeGreaterThan(0); // trend toward the limit
  });
});

describe('logistic regression', () => {
  it('separates clearly separable data and reports sane metrics', () => {
    const data: LabelledSample[] = [];
    for (let i = 0; i < 400; i++) {
      const y = i % 2 === 0 ? 1 : 0;
      const wiggle = ((i * 7919) % 100) / 1000;
      data.push({ x: [y ? 0.05 + wiggle : 0.6 + wiggle, y ? 0.3 : -0.1, y ? -0.1 : 0.5, 0.01, y ? 2 : 0], y: y as 0 | 1, lead: y ? 5 : 0 });
    }
    const fit = fitLogistic(data.slice(0, 300));
    const ev = evaluate(fit, data.slice(300));
    expect(ev.auc).toBeGreaterThan(0.95);
    expect(ev.accuracy).toBeGreaterThan(0.95);
  });

  it('computes AUC correctly at the extremes', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 1])).toBe(0.5); // one class only: undefined, reported as chance
  });

  it('synthetic training is reproducible and good enough to ship', () => {
    const a = trainModel(2000, 800, 7);
    const b = trainModel(2000, 800, 7);
    expect(a.weights).toEqual(b.weights);
    expect(a.evaluation.auc).toBeGreaterThan(0.9);
    expect(a.source).toBe('synthetic');
    const p = scoreFeatures(a, [0.05, 0.3, -0.2, 0.01, 4]); // little headroom, climbing fast
    const q = scoreFeatures(a, [0.7, -0.05, 0.75, 0.01, -0.1]); // lots of headroom, falling
    expect(p).toBeGreaterThan(ALERT_PROB);
    expect(q).toBeLessThan(0.2);
  });
});

describe('model registry', () => {
  it('falls back to the global model until a machine type has its own', () => {
    const global = loadModel();
    expect(modelFor('Registry Type')).toBe(global);
    const own = { ...global, scope: 'Registry Type', source: 'telemetry' as const };
    registerModel('Registry Type', own);
    expect(modelFor('Registry Type')).toBe(own);
    expect(modelFor('Other Type')).toBe(global);
    forgetModel('Registry Type');
    expect(modelFor('Registry Type')).toBe(global);
  });
});

describe('predictor', () => {
  const limits = { temperature: 70, battery: 20 };

  it('flags a metric climbing toward its limit, with an ETA', () => {
    const p = predictFromSeries(series(Array.from({ length: 20 }, (_, i) => 45 + i * 1.2)), limits); // 45 -> 67.8
    const t = p.metrics.find((m) => m.metric === 'temperature')!;
    expect(t.level).toBe('high');
    expect(t.probability).toBeGreaterThanOrEqual(ALERT_PROB);
    expect(t.secondsToBreach).not.toBeNull();
    expect(t.secondsToBreach!).toBeLessThan(40);
    expect(t.forecast).toHaveLength(HORIZON + 1);
  });

  it('leaves a steady metric alone', () => {
    const flat = Array.from({ length: 20 }, (_, i) => 40 + (i % 2) * 0.2);
    expect(predictFromSeries(series(flat), limits).level).toBe('low');
  });

  it('reports a metric that is already over its limit as breached', () => {
    const over = Array.from({ length: 12 }, (_, i) => 66 + i); // ends at 77
    const p = predictFromSeries(series(over), limits);
    expect(p.level).toBe('breached');
    expect(p.metrics[0].secondsToBreach).toBe(0);
  });

  it('handles lower-is-worse metrics such as a draining battery', () => {
    const draining = Array.from({ length: 20 }, (_, i) => 60 - i * 1.8); // 60 -> 25.8, limit 20
    const p = predictFromSeries(series(draining, 'battery'), limits);
    expect(p.metrics.find((m) => m.metric === 'battery')!.level).toBe('high');
  });

  it('ignores metrics without enough readings or without a limit', () => {
    expect(predictFromSeries(series([40, 41, 42]), limits).metrics).toHaveLength(0);
    expect(predictFromSeries(series(Array(20).fill(50)), {}).metrics).toHaveLength(0);
  });
});

describe('labelled windows built from telemetry', () => {
  const times = (n: number) => Array.from({ length: n }, (_, i) => i * 2000);

  it('labels windows that run into a breach as positive and skips already-breached ones', () => {
    // flat at 40, then a ramp that crosses 70 around index 100, then stays high
    const values = Array.from({ length: 160 }, (_, i) => (i < 70 ? 40 : Math.min(90, 40 + (i - 70) * 1.5)));
    const samples = windowsFrom(values, times(values.length), 1, 50, 70);
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.some((s) => s.y === 1)).toBe(true);
    expect(samples.some((s) => s.y === 0)).toBe(true);
    // every positive must carry a lead time inside the horizon
    for (const s of samples.filter((x) => x.y === 1)) { expect(s.lead).toBeGreaterThan(0); expect(s.lead).toBeLessThanOrEqual(HORIZON); }
  });

  it('produces nothing from a series that is too short', () => {
    expect(windowsFrom([1, 2, 3], times(3), 1, 10, 5)).toEqual([]);
  });

  it('skips windows that straddle an outage', () => {
    const values = Array.from({ length: 80 }, () => 40);
    const t = times(80).map((x, i) => (i >= 40 ? x + 3_600_000 : x)); // an hour-long gap in the middle
    const gapped = windowsFrom(values, t, 1, 50, 70).length;
    const clean = windowsFrom(values, times(80), 1, 50, 70).length;
    expect(gapped).toBeLessThan(clean);
  });
});
