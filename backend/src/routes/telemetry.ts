import { Router } from 'express';
import { z } from 'zod';
import { col } from '../mongo';
import { ingest } from '../services/ingest';
import { asyncH, HttpError, hashKey } from '../util';

/** Device-facing ingest API, authenticated with the per-device key (x-api-key). */
export const telemetryRouter = Router();

const num = (min: number, max: number) => z.number().min(min).max(max).optional();
const bodySchema = z.object({
  temperature: num(-60, 200),
  cpu: num(0, 100),
  memory: num(0, 100),
  battery: num(0, 100),
  signal: num(-130, 0),
  vibration: num(0, 200),
  pressure: num(0, 1000),
  current: num(0, 1000),
});

async function authDevice(key: unknown) {
  if (typeof key !== 'string' || !key) throw new HttpError(401, 'Missing x-api-key header');
  const dev = await col('devices').findOne({ apiKeyHash: hashKey(key) }, { projection: { active: 1 } });
  if (!dev) throw new HttpError(401, 'Unknown device key');
  if (dev.active === false) throw new HttpError(403, 'This device has been deactivated');
  return dev._id as unknown as string;
}

telemetryRouter.post('/', asyncH(async (req, res) => {
  const id = await authDevice(req.header('x-api-key'));
  await ingest(id, bodySchema.parse(req.body ?? {}));
  res.status(202).json({ accepted: true });
}));

telemetryRouter.post('/heartbeat', asyncH(async (req, res) => {
  const id = await authDevice(req.header('x-api-key'));
  await ingest(id, {});
  res.status(202).json({ accepted: true });
}));
