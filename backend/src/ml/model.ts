import fs from 'fs';
import path from 'path';
import { extract, FEATURE_NAMES, HORIZON, WINDOW } from './features';

/**
 * Anomaly *prediction* model: logistic regression that answers
 *   "will this metric cross its alert threshold within the next HORIZON readings?"
 * The global model is trained on synthetic telemetry (drifts, leaks, decays, noise,
 * recoveries) generated in normalised units, so one model serves every metric.
 * A machine type can get its own model, retrained from the telemetry it has produced.
 */

export interface Evaluation {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number;
  brier: number;
  avgLeadReadings: number; // how many readings *before* the breach the model fires (p >= ALERT_PROB)
  positiveRate: number;
}

export interface TrainedModel {
  version: string;
  trainedAt: string;
  /** 'global' or the machine type this model was fitted for */
  scope: string;
  source: 'synthetic' | 'telemetry';
  featureNames: string[];
  weights: number[];
  bias: number;
  mean: number[];
  std: number[];
  window: number;
  horizon: number;
  trainSize: number;
  testSize: number;
  evaluation: Evaluation;
}

export interface LabelledSample { x: number[]; y: 0 | 1; lead: number }

export const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'anomaly-model.json');
export const ALERT_PROB = 0.5;

// ---- deterministic RNG so training is reproducible ----
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** One synthetic episode in normalised units (range = 1, breach level = 1). */
function genSample(r: () => number): LabelledSample {
  const u = (a: number, b: number) => a + r() * (b - a);
  const L0 = 1 - u(0.08, 0.8);
  const sigma = Math.exp(u(Math.log(0.0005), Math.log(0.03))); // log-uniform: covers very clean (battery) to noisy (CPU) signals
  const scenario = r();
  let slope = 0;
  let onset = 0;
  if (scenario < 0.3) slope = 0; // healthy and flat
  else if (scenario < 0.72) { slope = u(0.002, 0.04); onset = Math.floor(u(0, WINDOW)); } // drift toward breach
  else if (scenario < 0.85) { slope = -u(0.002, 0.03); } // recovering
  else { slope = u(0.0005, 0.004); } // slow creep - rarely breaches in horizon

  const total = WINDOW + HORIZON;
  let noise = 0;
  const obs: number[] = [];
  for (let t = 0; t < total; t++) {
    noise = 0.5 * noise + sigma * gauss(r);
    obs.push(L0 + (t > onset ? slope * (t - onset) : 0) + noise);
  }
  const ex = extract(obs.slice(0, WINDOW), 1, 1)!;
  let lead = 0;
  let y: 0 | 1 = 0;
  for (let t = WINDOW; t < total; t++) {
    if (obs[t] >= 1) { y = 1; lead = t - WINDOW + 1; break; }
  }
  return { x: ex.x, y, lead };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Full-batch gradient descent with L2 regularisation and optional up-weighting of the positive class. */
export function fitLogistic(train: LabelledSample[], opts: { positiveWeight?: number; epochs?: number } = {}) {
  const d = FEATURE_NAMES.length;
  const pw = opts.positiveWeight ?? 1;
  const mean = Array(d).fill(0);
  const std = Array(d).fill(0);
  for (const s of train) s.x.forEach((v, i) => (mean[i] += v / train.length));
  for (const s of train) s.x.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / train.length));
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]) || 1;

  const Z = train.map((s) => s.x.map((v, i) => (v - mean[i]) / std[i]));
  const sw = train.map((s) => (s.y ? pw : 1));
  const wsum = sw.reduce((a, b) => a + b, 0);
  const w = Array(d).fill(0);
  let b = 0;
  const lr = 0.5, l2 = 1e-3;
  for (let epoch = 0; epoch < (opts.epochs ?? 800); epoch++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let n = 0; n < Z.length; n++) {
      let s = b;
      for (let i = 0; i < d; i++) s += w[i] * Z[n][i];
      const err = (sigmoid(s) - train[n].y) * sw[n];
      for (let i = 0; i < d; i++) gw[i] += err * Z[n][i];
      gb += err;
    }
    for (let i = 0; i < d; i++) w[i] -= lr * (gw[i] / wsum + l2 * w[i]);
    b -= lr * (gb / wsum);
  }
  return { weights: w, bias: b, mean, std };
}

export function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0;
  idx.forEach((i, rank) => { if (labels[i]) { rankSum += rank + 1; nPos++; } });
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function scoreFeatures(model: Pick<TrainedModel, 'weights' | 'bias' | 'mean' | 'std'>, x: number[]): number {
  let s = model.bias;
  for (let i = 0; i < x.length; i++) s += (model.weights[i] * (x[i] - model.mean[i])) / model.std[i];
  return sigmoid(s);
}

/** Held-out evaluation: how well does the model separate episodes that breach from those that do not? */
export function evaluate(model: Pick<TrainedModel, 'weights' | 'bias' | 'mean' | 'std'>, test: LabelledSample[]): Evaluation {
  const probs = test.map((s) => scoreFeatures(model, s.x));
  let tp = 0, fp = 0, tn = 0, fn = 0, brier = 0, leadSum = 0, leadN = 0, pos = 0;
  test.forEach((s, i) => {
    const pred = probs[i] >= ALERT_PROB ? 1 : 0;
    if (s.y) pos++;
    if (pred && s.y) { tp++; leadSum += s.lead; leadN++; }
    else if (pred && !s.y) fp++;
    else if (!pred && s.y) fn++;
    else tn++;
    brier += (probs[i] - s.y) ** 2 / test.length;
  });
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  return {
    accuracy: (tp + tn) / test.length,
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(1e-9, precision + recall),
    auc: auc(probs, test.map((s) => s.y)),
    brier,
    avgLeadReadings: leadN ? leadSum / leadN : 0,
    positiveRate: pos / test.length,
  };
}

export function trainModel(trainN = 8000, testN = 3000, seed = 42): TrainedModel {
  const r = mulberry32(seed);
  const gen = (n: number) => {
    const out: LabelledSample[] = [];
    while (out.length < n) {
      const s = genSample(r);
      if (s.x[0] > 0) out.push(s); // skip episodes that are already breached at the end of the window
    }
    return out;
  };
  const train = gen(trainN);
  const test = gen(testN);
  const fit = fitLogistic(train);
  return {
    version: '1.0.0',
    trainedAt: new Date().toISOString(),
    scope: 'global',
    source: 'synthetic',
    featureNames: FEATURE_NAMES,
    ...fit,
    window: WINDOW,
    horizon: HORIZON,
    trainSize: trainN,
    testSize: testN,
    evaluation: evaluate(fit, test),
  };
}

/* ------------------------------------------------------------------ model registry */

let globalModel: TrainedModel | null = null;
const typeModels = new Map<string, TrainedModel>();

/** The global model: loaded from disk, or trained (and saved) on first use. */
export function loadModel(): TrainedModel {
  if (globalModel) return globalModel;
  if (fs.existsSync(MODEL_PATH)) {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')) as TrainedModel;
    globalModel = { ...m, scope: m.scope ?? 'global', source: m.source ?? 'synthetic' };
  } else {
    globalModel = trainModel();
    fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
    fs.writeFileSync(MODEL_PATH, JSON.stringify(globalModel, null, 2));
  }
  return globalModel;
}

/** Register a model for 'global' or one machine type (called at boot and after retraining). */
export function registerModel(scope: string, model: TrainedModel) {
  if (scope === 'global') globalModel = model;
  else typeModels.set(scope, model);
}

export function forgetModel(scope: string) {
  if (scope === 'global') globalModel = null;
  else typeModels.delete(scope);
}

/** A machine type uses its own model when one has been trained, otherwise the global one. */
export function modelFor(type: string | null | undefined): TrainedModel {
  return (type && typeModels.get(type)) || loadModel();
}

export const modelScopes = () => ['global', ...typeModels.keys()];
