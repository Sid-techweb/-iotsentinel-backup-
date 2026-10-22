import { Router } from 'express';
import { z } from 'zod';
import { col } from '../mongo';
import { ALERT_PROB, forgetModel, loadModel, modelFor } from '../ml/model';
import { predictFromSeries } from '../ml/predictor';
import { audit, ctxOf } from '../services/audit';
import { getDeviceTypes } from '../services/deviceTypes';
import { publish } from '../services/events';
import { predictDevice, recentPoints } from '../services/prediction';
import { listPredictionHistory } from '../services/predictionHistory';
import { activateModelVersion, listModelVersions, retrain } from '../services/retrain';
import { predictionLimits } from '../services/rules';
import { asyncH, HttpError } from '../util';

export const anomalyRouter = Router();

/** Fleet-wide forecast, riskiest device first. Each device is judged with its machine type's limits and model. */
anomalyRouter.get('/predictions', asyncH(async (_req, res) => {
  const devices = (await col('devices').find({ status: { $ne: 'offline' }, active: { $ne: false } }, { projection: { assetNo: 1, name: 1, type: 1, location: 1, status: 1 } }).toArray())
    .map((d) => ({ ...d, id: d._id as unknown as string }));
  const limitsByType = new Map<string, Awaited<ReturnType<typeof predictionLimits>>>();
  const out = [];
  for (const d of devices) {
    if (!limitsByType.has(d.type)) limitsByType.set(d.type, await predictionLimits(d.type));
    const p = predictFromSeries(await recentPoints(d.id), limitsByType.get(d.type)!, d.type);
    out.push({
      deviceId: d.id, assetNo: d.assetNo, name: d.name, type: d.type, location: d.location, status: d.status,
      riskScore: p.riskScore, level: p.level, topMetric: p.topMetric, secondsToBreach: p.secondsToBreach,
      metrics: p.metrics.map(({ forecast: _forecast, explanation, ...m }) => ({ ...m, modelVersion: explanation.model.version, modelSource: explanation.model.source })),
    });
  }
  out.sort((a, b) => b.riskScore - a.riskScore);
  res.json(out);
}));

/** One device: recent history plus the model's forecast curve and explanation per metric. */
anomalyRouter.get('/predictions/:deviceId', asyncH(async (req, res) => {
  const d = await col('devices').findOne({ _id: String(req.params.deviceId) as any }, { projection: { assetNo: 1, name: 1, type: 1, location: 1, status: 1, active: 1 } });
  if (!d) throw new HttpError(404, 'Device not found');
  const dev = { id: d._id as unknown as string, assetNo: d.assetNo, name: d.name, type: d.type, location: d.location, status: d.status, active: d.active !== false };
  const { points, prediction } = await predictDevice(dev.id, dev.type);
  res.json({ device: dev, points, prediction });
}));

/**
 * Why does this device have the risk it has? Returns, per signal, the exact contribution of every
 * feature to the model's log-odds plus the readings it was computed from. No forecast curves.
 */
anomalyRouter.get('/explain/:deviceId', asyncH(async (req, res) => {
  const { metric } = z.object({ metric: z.string().optional() }).parse(req.query);
  const d = await col('devices').findOne({ _id: String(req.params.deviceId) as any }, { projection: { assetNo: 1, name: 1, type: 1 } });
  if (!d) throw new HttpError(404, 'Device not found');
  const dev = { id: d._id as unknown as string, assetNo: d.assetNo, name: d.name, type: d.type };
  const { points, prediction } = await predictDevice(dev.id, dev.type);
  const recent = points.slice(-10);
  res.json({
    device: dev,
    level: prediction.level,
    riskScore: prediction.riskScore,
    note: 'Probabilities are the chance that a configured threshold is crossed within the horizon. They are not the probability of equipment failure.',
    metrics: prediction.metrics
      .filter((m) => !metric || m.metric === metric)
      .map(({ forecast: _curve, ...m }) => ({ ...m, recentReadings: recent.map((p) => ({ ts: p.ts, value: p[m.metric] })).filter((r) => r.value !== null) })),
  });
}));

/** Stored prediction snapshots (what the model predicted, with the model version and explanation). */
anomalyRouter.get('/history', asyncH(async (req, res) => {
  const f = z.object({
    deviceId: z.string().uuid().optional(), metric: z.string().max(20).optional(),
    before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
  }).parse(req.query);
  res.json(await listPredictionHistory(f));
}));

/** The scopes that have a model: the global one, plus every machine type with a model trained on its own telemetry. */
anomalyRouter.get('/models', asyncH(async (_req, res) => {
  const [types, stored] = await Promise.all([
    getDeviceTypes(),
    col('models').find({}).toArray().then((rows) => rows.map((r) => ({ ...r, scope: r._id as unknown as string }))),
  ]);
  const g = loadModel();
  res.json([
    { scope: 'global', source: g.source, samples: g.trainSize + g.testSize, trainedAt: g.trainedAt, auc: g.evaluation.auc, version: g.version, own: true },
    ...types.map((t) => {
      const s = stored.find((m: any) => m.scope === t.name);
      return s
        ? { scope: t.name, source: s.source, samples: s.samples, trainedAt: s.trainedAt, auc: s.model?.evaluation?.auc ?? null, version: s.model?.version ?? null, own: true }
        : { scope: t.name, source: g.source, samples: 0, trainedAt: g.trainedAt, auc: g.evaluation.auc, version: g.version, own: false };
    }),
  ]);
}));

/** Model card for a scope ('global' or a machine type). A type without its own model shows the global one. */
anomalyRouter.get('/model', asyncH(async (req, res) => {
  const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : 'global';
  const m = scope === 'global' ? loadModel() : modelFor(scope);
  const { weights, featureNames, ...rest } = m;
  res.json({
    ...rest,
    requestedScope: scope,
    fallback: scope !== 'global' && m.scope !== scope,
    algorithm: 'Logistic regression on windowed trend features',
    features: featureNames.map((name, i) => ({ name, weight: weights[i] })),
    alertProbability: ALERT_PROB,
    parameterCount: weights.length + 1,
    target: 'Whether a signal crosses its configured alert threshold within the next horizon (threshold breach, not equipment failure)',
  });
}));

/** Every trained version for a scope, including rejected retrains, newest first. */
anomalyRouter.get('/models/:scope/versions', asyncH(async (req, res) => {
  res.json(await listModelVersions(String(req.params.scope)));
}));

/** Roll back to an earlier version that passed the validation gate (admin). */
anomalyRouter.post('/models/:scope/versions/:version/activate', asyncH(async (req, res) => {
  const scope = String(req.params.scope);
  const version = z.coerce.number().int().positive().parse(req.params.version);
  if (scope === 'global') throw new HttpError(400, 'The built-in global model has a single version');
  const row = await activateModelVersion(scope, version);
  audit(ctxOf(req), 'model.activate_version', 'model', scope, { version });
  res.json(row);
}));

/** Fit a model for one machine type from its stored telemetry (admin). */
anomalyRouter.post('/retrain', asyncH(async (req, res) => {
  const { deviceType } = z.object({ deviceType: z.string().min(1) }).parse(req.body);
  const result = await retrain(deviceType, req.user?.email ?? 'system');
  audit(ctxOf(req), 'model.retrain', 'model', deviceType, { version: result.version, activated: result.activated, auc: result.evaluation.auc });
  res.json(result);
}));

/** Drop a machine type's own model so it falls back to the global one (admin). */
anomalyRouter.delete('/models/:scope', asyncH(async (req, res) => {
  const scope = String(req.params.scope);
  if (scope === 'global') throw new HttpError(400, 'The global model cannot be removed');
  await col('models').deleteOne({ _id: scope as any });
  await col('model_versions').updateMany({ scope }, { $set: { isActive: false } });
  forgetModel(scope);
  publish('model', { scope });
  audit(ctxOf(req), 'model.reset_to_global', 'model', scope);
  res.status(204).end();
}));
