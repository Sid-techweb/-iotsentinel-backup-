import { pool, q, q1 } from '../db';
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
  const devices = await q<{ id: string }>('SELECT id FROM devices WHERE type=$1', [scope]);
  if (!devices.length) throw new HttpError(422, 'No devices of this machine type yet');

  const train: LabelledSample[] = [];
  const test: LabelledSample[] = [];
  let purged = 0;
  const gap = Math.ceil((WINDOW + HORIZON) / STEP);
  for (const dev of devices) {
    for (const metric of type.metrics) {
      const threshold = limits[metric];
      if (threshold === undefined || !(METRIC_KEYS as readonly string[]).includes(metric)) continue;
      // the column name comes from the METRIC_KEYS whitelist, never from user input
      const rows = await q<{ ts: Date; v: number }>(
        `SELECT ts, ${metric} AS v FROM telemetry WHERE device_id=$1 AND ${metric} IS NOT NULL ORDER BY ts DESC LIMIT ${MAX_READINGS}`,
        [dev.id],
      );
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

  const client = await pool.connect();
  let versionNo = 1;
  let model: TrainedModel;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`model-version:${scope}`]);
    versionNo = ((await client.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM model_versions WHERE scope=$1', [scope])).rows[0].v as number);
    model = {
      version: `v${versionNo}`,
      trainedAt: new Date().toISOString(),
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
    if (activated) await client.query('UPDATE model_versions SET is_active=false WHERE scope=$1 AND is_active', [scope]);
    await client.query(
      `INSERT INTO model_versions (scope, version, source, samples, evaluation, previous_evaluation, activated, is_active, reason, trained_by, model)
       VALUES ($1,$2,'telemetry',$3,$4,$5,$6,$6,$7,$8,$9)`,
      [scope, versionNo, tr.length + test.length, JSON.stringify(evaluation), JSON.stringify(previous), activated, reason, by, JSON.stringify(model)],
    );
    if (activated) {
      await client.query(
        `INSERT INTO models (scope, model, source, samples, trained_at) VALUES ($1,$2,'telemetry',$3, now())
         ON CONFLICT (scope) DO UPDATE SET model=EXCLUDED.model, source='telemetry', samples=EXCLUDED.samples, trained_at=now()`,
        [scope, JSON.stringify(model), tr.length + test.length],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (activated) {
    registerModel(scope, model);
    publish('model', { scope });
  }
  return { scope, version: versionNo, activated, reason, samples: { train: tr.length, test: test.length, positives, purged }, evaluation, previous };
}

const versionColumns = 'id, scope, version, source, samples, evaluation, previous_evaluation, activated, is_active, reason, trained_by, trained_at';

export const listModelVersions = (scope: string) =>
  q<ModelVersionRow>(`SELECT ${versionColumns} FROM model_versions WHERE scope=$1 ORDER BY version DESC`, [scope]);

/** Make an earlier, previously accepted version the active one again (rollback). */
export async function activateModelVersion(scope: string, version: number): Promise<ModelVersionRow> {
  const row = await q1<{ id: number; activated: boolean; model: TrainedModel; samples: number }>(
    'SELECT id, activated, model, samples FROM model_versions WHERE scope=$1 AND version=$2', [scope, version]);
  if (!row) throw new HttpError(404, `Model version ${version} not found for ${scope}`);
  if (!row.activated) throw new HttpError(409, 'That version was rejected by the validation gate and cannot be activated');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE model_versions SET is_active=false WHERE scope=$1 AND is_active', [scope]);
    await client.query('UPDATE model_versions SET is_active=true WHERE id=$1', [row.id]);
    if (scope !== 'global') {
      await client.query(
        `INSERT INTO models (scope, model, source, samples, trained_at) VALUES ($1,$2,'telemetry',$3, now())
         ON CONFLICT (scope) DO UPDATE SET model=EXCLUDED.model, source='telemetry', samples=EXCLUDED.samples, trained_at=now()`,
        [scope, JSON.stringify(row.model), row.samples],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (scope !== 'global') registerModel(scope, { ...row.model, scope });
  publish('model', { scope });
  return (await q1<ModelVersionRow>(`SELECT ${versionColumns} FROM model_versions WHERE id=$1`, [row.id]))!;
}

/** Make sure the built-in global model appears as version 1 in the version history. */
export async function ensureGlobalVersion() {
  const g = loadModel();
  await q(
    `INSERT INTO model_versions (scope, version, source, samples, evaluation, activated, is_active, reason, trained_by, model, trained_at)
     VALUES ('global', 1, 'synthetic', $1, $2, true, true, 'Built-in model trained on synthetic episodes (npm run train)', 'system', $3, $4)
     ON CONFLICT (scope, version) DO NOTHING`,
    [g.trainSize + g.testSize, JSON.stringify(g.evaluation), JSON.stringify(g), g.trainedAt],
  );
}

/** Load models trained in earlier runs so predictions use them straight after a restart. */
export async function loadStoredModels() {
  const rows = await q<{ scope: string; model: TrainedModel }>('SELECT scope, model FROM models');
  for (const r of rows) registerModel(r.scope, { ...r.model, scope: r.scope });
}
