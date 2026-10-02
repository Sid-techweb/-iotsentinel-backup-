import { Router } from 'express';
import { q, q1 } from '../db';
import { loadModel } from '../ml/model';
import { predictFromSeries } from '../ml/predictor';
import { predictDevice, recentPoints } from '../services/prediction';
import { predictionLimits } from '../services/rules';
import { asyncH, HttpError } from '../util';

export const anomalyRouter = Router();

/** Fleet-wide forecast, riskiest device first. */
anomalyRouter.get('/predictions', asyncH(async (_req, res) => {
  const [devices, limits] = await Promise.all([
    q<any>(`SELECT id, name, type, location, status FROM devices WHERE status <> 'offline'`),
    predictionLimits(),
  ]);
  const out = [];
  for (const d of devices) {
    const p = predictFromSeries(await recentPoints(d.id), limits);
    out.push({
      deviceId: d.id, name: d.name, type: d.type, location: d.location, status: d.status,
      riskScore: p.riskScore, level: p.level, topMetric: p.topMetric, secondsToBreach: p.secondsToBreach,
      metrics: p.metrics.map(({ forecast, ...m }) => m),
    });
  }
  out.sort((a, b) => b.riskScore - a.riskScore);
  res.json(out);
}));

/** One device: recent history plus the model's forecast curve per metric. */
anomalyRouter.get('/predictions/:deviceId', asyncH(async (req, res) => {
  const dev = await q1('SELECT id, name, type, location, status FROM devices WHERE id=$1', [req.params.deviceId]).catch(() => undefined);
  if (!dev) throw new HttpError(404, 'Device not found');
  const { points, prediction } = await predictDevice(dev.id);
  res.json({ device: dev, points, prediction });
}));

anomalyRouter.get('/model', asyncH(async (_req, res) => {
  const { weights, featureNames, ...rest } = loadModel();
  const m = loadModel();
  res.json({
    ...rest,
    algorithm: 'Logistic regression on windowed trend features',
    features: featureNames.map((name, i) => ({ name, weight: weights[i] })),
    m: undefined,
    alertProbability: 0.5,
    parameterCount: m.weights.length + 1,
  });
}));
