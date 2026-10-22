import { col, nextId, toApi } from '../mongo';
import { extract, HORIZON, WINDOW } from '../ml/features';
import { METRIC_KEYS, METRICS } from '../ml/metrics';
import { evaluate, Evaluation, fitLogistic, LabelledSample, loadModel, modelFor, registerModel, TrainedModel } from '../ml/model';
import { FEATURE_NAMES } from '../ml/features';
import { HttpError } from '../util';
import { getDeviceType } from './deviceTypes';
import { publish } from './events';
import { predictionLimits } from './rules';

const STEP = 3;               // slide the window by this many readings
const MAX_READINGS = 5000;    // per device and metric
const MAX_SAMPLES = 20000;
const MIN_TRAIN = 150;
const MIN_POSITIVES = 15;
const MIN_AUC = 0.7;

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Cut one signal's history into (window -> did it cross the limit within the horizon?) examples. */
export function windowsFrom(values: number[], times: number[], dir: 1 | -1, range: number, threshold: number): LabelledSample[] {
  const out: LabelledSample[] = [];
  if (values.length < WINDOW + HORIZON) return out;
  const stress = values.map((v) => dir * v);
  const T = dir * threshold;
  const dt = median(times.slice(1).map((t, i) => t - times[i])) || 2000;
  for (let t = WINDOW; t + HORIZON <= stress.length; t += STEP) {
    // skip windows that straddle an outage - the readings are not evenly spaced there
    if (times[t + HORIZON - 1] - times[t - WINDOW] > (WINDOW + HORIZON) * dt * 2.5) continue;
    if (stress[t - 1] >= T) continue; // already breached: nothing left to predict
    const ex = extract(stress.slice(t - WINDOW, t), T, range);
    if (!ex) continue;
    let lead = 0;
    for (let k = 0; k < HORIZON; k++) { if (stress[t + k] >= T) { lead = k + 1; break; } }
    out.push({ x: ex.x, y: lead > 0 ? 1 : 0, lead });
  }
  return out;
}

export interface ModelVersionRow {
  id: number; scope: string; version: number; source: 'synthetic' | 'telemetry'; samples: number;
  evaluation: Evaluation; previousEvaluation: Evaluation | null; activated: boolean; isActive: boolean;
  reason: string; trainedBy: string; trainedAt: string;
}

export interface RetrainResult {
  scope: string;
  version: number;
  activated: boolean;
  reason: string;
  samples: { train: number; test: number; positives: number; purged: number };
  evaluation: Evaluation;
  previous: Evaluation;
}

/**
 * Fit a prediction model for one machine type from the telemetry its devices have actually produced.
 *
 * What is learned: whether a signal crossed its CONFIGURED THRESHOLD within the next HORIZON readings.
 * That is a threshold-breach label derived from stored telemetry - not an equipment-failure label.
 *
 * Evaluation is strictly time-based: for every device and signal the older 80 % of windows train the model
 * and the most recent 20 % test it. A purge gap of WINDOW + HORIZON readings is dropped between the two so
 * no training window can see (through its look-ahead label) data that a test window also uses.
 *
 * The new model only replaces the active one when it reaches AUC >= 0.70 and is not clearly worse than the
 * model it would replace on the same test data. Every attempt - accepted or rejected - is stored as a version.
 */
export async function retrain(scope: string, by = 'system'): Promise<RetrainResult> {
  const type = await getDeviceType(scope);
  if (!type) throw new HttpError(404, `Unknown machine type "${scope}"`);
  const limits = await predictionLimits(scope);
  const devices = (await col('devices').find({ type: scope }, { projection: { _id: 1 } }).toArray()).map((d) => ({ id: d._id as unknown as string }));
  if (!devices.length) throw new HttpError(422, 'No devices of this machine type yet');

  const train: LabelledSample[] = [];
  const test: LabelledSample[] = [];
  let purged = 0;
  const gap = Math.ceil((WINDOW + HORIZON) / STEP);
  for (const dev of devices) {
    for (const metric of type.metrics) {
      const threshold = limits[metric];
      if (threshold === undefined || !(METRIC_KEYS as readonly string[]).includes(metric)) continue;
      // the field name comes from the METRIC_KEYS whitelist (checked above), never from user input
      const rows = (await col('telemetry').find({ deviceId: dev.id, [metric]: { $ne: null } }, { projection: { _id: 0, ts: 1, [metric]: 1 } })
        .sort({ ts: -1 }).limit(MAX_READINGS).toArray()).map((r) => ({ ts: r.ts as Date, v: r[metric] as number }));
      rows.reverse();
      const { dir, range } = METRICS[metric];
      const samples = windowsFrom(rows.map((r) => r.v), rows.map((r) => new Date(r.ts).getTime()), dir, range, threshold);
      const cut = Math.floor(samples.length * 0.8); // chronological split: test on the most recent 20 %
      const trainEnd = Math.max(0, cut - gap);
      purged += cut - trainEnd;
      train.push(...samples.slice(0, trainEnd));
      test.push(...samples.slice(cut));
    }
  }
  const shrink = (a: LabelledSample[]) => (a.length > MAX_SAMPLES ? a.filter((_, i) => i % Math.ceil(a.length / MAX_SAMPLES) === 0) : a);
  const tr = shrink(train);
  const positives = tr.filter((s) => s.y).length;
  const testPos = test.filter((s) => s.y).length;
  if (tr.length < MIN_TRAIN || positives < MIN_POSITIVES || tr.length - positives < MIN_POSITIVES || testPos < 3 || testPos === test.length) {
    throw new HttpError(422,
      `Not enough labelled telemetry yet: ${tr.length} training windows, ${positives} that ended in a threshold breach ` +
      `(need ${MIN_TRAIN}+ windows with ${MIN_POSITIVES}+ breaches and some normal ones). Let the devices run longer or trigger faults.`);
  }

  const fit = fitLogistic(tr, { positiveWeight: Math.min(5, Math.max(1, (tr.length - positives) / positives)) });
  const evaluation = evaluate(fit, test);
  const previous = evaluate(modelFor(scope), test);

  const activated = evaluation.auc >= MIN_AUC && evaluation.auc >= previous.auc - 0.03;
  const reason = activated
    ? `Activated: AUC ${evaluation.auc.toFixed(2)} on ${test.length} recent held-out windows (previous model ${previous.auc.toFixed(2)}).`
    : evaluation.auc < MIN_AUC
      ? `Kept the previous model: the new one only reached AUC ${evaluation.auc.toFixed(2)} (needs ${MIN_AUC}).`
      : `Kept the previous model: it scores AUC ${previous.auc.toFixed(2)} on the same data, higher than the new ${evaluation.auc.toFixed(2)}.`;

  const nowIso = new Date();
  let versionNo = 1;
  let model!: TrainedModel;
  for (let attempt = 0; ; attempt++) {
    const last = await col('model_versions').find({ scope }, { projection: { version: 1 } }).sort({ version: -1 }).limit(1).next();
    versionNo = (last?.version ?? 0) + 1;
    model = {
      version: `v${versionNo}`,
      trainedAt: nowIso.toISOString(),
      scope,
      source: 'telemetry',
      featureNames: FEATURE_NAMES,
      ...fit,
      window: WINDOW,
      horizon: HORIZON,
      trainSize: tr.length,
      testSize: test.length,
      evaluation,
    };
    try {
      // inserted as inactive first: the unique "one active version per scope" index is respected while switching
      await col('model_versions').insertOne({
        _id: (await nextId('model_versions')) as any, scope, version: versionNo, source: 'telemetry', samples: tr.length + test.length,
        evaluation: JSON.parse(JSON.stringify(evaluation)), previousEvaluation: JSON.parse(JSON.stringify(previous)), activated, isActive: false,
        reason, trainedBy: by, model: JSON.parse(JSON.stringify(model)), trainedAt: nowIso,
      });
      break;
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && attempt < 5) continue; // another retrain took this version number
      throw e;
    }
  }
  if (activated) {
    await col('model_versions').updateMany({ scope, isActive: true }, { $set: { isActive: false } });
    await col('model_versions').updateOne({ scope, version: versionNo }, { $set: { isActive: true } });
    await col('models').updateOne({ _id: scope as any }, { $set: { model: JSON.parse(JSON.stringify(model)), source: 'telemetry', samples: tr.length + test.length, trainedAt: new Date() } }, { upsert: true });
  }
  if (activated) {
    registerModel(scope, model);
    publish('model', { scope });
  }
  return { scope, version: versionNo, activated, reason, samples: { train: tr.length, test: test.length, positives, purged }, evaluation, previous };
}

const versionView = (d: any): ModelVersionRow => { const { model: _m, ...rest } = toApi(d)!; return rest as ModelVersionRow; };

export const listModelVersions = async (scope: string) =>
  (await col('model_versions').find({ scope }).sort({ version: -1 }).toArray()).map(versionView);

/** Make an earlier, previously accepted version the active one again (rollback). */
export async function activateModelVersion(scope: string, version: number): Promise<ModelVersionRow> {
  const row = await col('model_versions').findOne({ scope, version });
  if (!row) throw new HttpError(404, `Model version ${version} not found for ${scope}`);
  if (!row.activated) throw new HttpError(409, 'That version was rejected by the validation gate and cannot be activated');
  await col('model_versions').updateMany({ scope, isActive: true }, { $set: { isActive: false } });
  await col('model_versions').updateOne({ _id: row._id }, { $set: { isActive: true } });
  if (scope !== 'global') {
    await col('models').updateOne({ _id: scope as any }, { $set: { model: row.model, source: 'telemetry', samples: row.samples, trainedAt: new Date() } }, { upsert: true });
  }
  if (scope !== 'global') registerModel(scope, { ...(row.model as TrainedModel), scope });
  publish('model', { scope });
  return versionView(await col('model_versions').findOne({ _id: row._id }));
}

/** Make sure the built-in global model appears as version 1 in the version history. */
export async function ensureGlobalVersion() {
  const g = loadModel();
  const exists = await col('model_versions').findOne({ scope: 'global', version: 1 }, { projection: { _id: 1 } });
  if (exists) return;
  try {
    await col('model_versions').insertOne({
      _id: (await nextId('model_versions')) as any, scope: 'global', version: 1, source: 'synthetic', samples: g.trainSize + g.testSize,
      evaluation: JSON.parse(JSON.stringify(g.evaluation)), previousEvaluation: null, activated: true, isActive: true,
      reason: 'Built-in model trained on synthetic episodes (npm run train)', trainedBy: 'system', model: JSON.parse(JSON.stringify(g)), trainedAt: new Date(g.trainedAt),
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e; // another instance created it first
  }
}

/** Load models trained in earlier runs so predictions use them straight after a restart. */
export async function loadStoredModels() {
  const rows = await col('models').find({}).toArray();
  for (const r of rows) registerModel(r._id as unknown as string, { ...(r.model as TrainedModel), scope: r._id as unknown as string });
}
