import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { METRIC_KEYS } from '../ml/metrics';
import { injectFault, setSimulatorPaused, simulatorStatus } from '../services/simulator';
import { asyncH, HttpError } from '../util';

export const simulatorRouter = Router();

const status = () => ({ enabled: config.simulator, ...simulatorStatus() });

simulatorRouter.get('/', asyncH(async (_req, res) => res.json(status())));

/** Pausing silences every simulated device, which is a quick way to see missed-heartbeat detection. */
simulatorRouter.post('/pause', asyncH(async (_req, res) => { setSimulatorPaused(true); res.json(status()); }));
simulatorRouter.post('/resume', asyncH(async (_req, res) => { setSimulatorPaused(false); res.json(status()); }));

simulatorRouter.post('/inject-fault', asyncH(async (req, res) => {
  const b = z.object({ deviceId: z.string().uuid(), metric: z.enum(METRIC_KEYS).optional() }).parse(req.body);
  if (!(await injectFault(b.deviceId, b.metric))) throw new HttpError(409, 'That device is not simulated, or it is already degrading');
  res.status(202).json(status());
}));
