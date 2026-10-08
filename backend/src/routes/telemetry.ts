import { Router } from 'express';
import { z } from 'zod';
import { q1 } from '../db';
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
});

async function authDevice(key: unknown) {
  if (typeof key !== 'string' || !key) throw new HttpError(401, 'Missing x-api-key header');
  const dev = await q1<{ id: string }>('SELECT id FROM devices WHERE api_key_hash=$1', [hashKey(key)]);
  if (!dev) throw new HttpError(401, 'Unknown device key');
  return dev.id;
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
