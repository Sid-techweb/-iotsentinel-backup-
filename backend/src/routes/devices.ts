import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
import { keys, redis } from '../redis';
import { asyncH, compareVersions, hashKey, HttpError, newDeviceKey } from '../util';

export const DEVICE_TYPES = ['Smart Sensor', 'Asset Tracker', 'Gateway', 'IP Camera', 'Smart Meter', 'Industrial Controller'] as const;

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  type: z.enum(DEVICE_TYPES),
  location: z.string().trim().max(60).default('Unassigned'),
  ipAddress: z.string().trim().max(45).optional(),
  firmwareVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use semantic version, e.g. 1.2.0'),
  simulated: z.boolean().default(false),
});

const LIST_SQL = `
  SELECT d.id, d.name, d.type, d.location, d.ip_address, d.firmware_version, d.status, d.simulated, d.last_seen, d.created_at,
    (SELECT count(*)::int FROM alerts a WHERE a.device_id=d.id AND a.status<>'resolved') AS open_alerts,
    (SELECT r.version FROM firmware_releases r WHERE r.device_type=d.type ORDER BY r.released_at DESC, r.id DESC LIMIT 1) AS latest_firmware
  FROM devices d`;

async function withLatest(rows: any[]) {
  const latest = rows.length ? await redis.mget(rows.map((r) => keys.latest(r.id))) : [];
  return rows.map((r, i) => ({
    ...r,
    outdated: r.latestFirmware ? compareVersions(r.firmwareVersion, r.latestFirmware) < 0 : false,
    latest: latest[i] ? JSON.parse(latest[i]!) : null,
  }));
}

export const devicesRouter = Router();

devicesRouter.get('/', asyncH(async (req, res) => {
  const { status, q: search } = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`(d.name ILIKE $${params.length} OR d.location ILIKE $${params.length} OR d.type ILIKE $${params.length})`); }
  const rows = await q(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.name`, params);
  res.json(await withLatest(rows));
}));

devicesRouter.post('/', asyncH(async (req, res) => {
  const b = createSchema.parse(req.body);
  const dup = await q1('SELECT 1 FROM devices WHERE name=$1', [b.name]);
  if (dup) throw new HttpError(409, `A device named "${b.name}" already exists`);
  const apiKey = newDeviceKey();
  const row = await q1(
    `INSERT INTO devices (name, type, location, ip_address, firmware_version, api_key_hash, simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [b.name, b.type, b.location, b.ipAddress ?? null, b.firmwareVersion, hashKey(apiKey), b.simulated],
  );
  const [created] = await q(`${LIST_SQL} WHERE d.id=$1`, [row.id]);
  // the raw key is returned exactly once - only its hash is stored
  res.status(201).json({ ...(await withLatest([created]))[0], apiKey });
}));

devicesRouter.get('/:id', asyncH(async (req, res) => {
  const rows = await q(`${LIST_SQL} WHERE d.id=$1`, [req.params.id]).catch(() => []);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  res.json((await withLatest(rows))[0]);
}));

/** Issue a new device key. The old one stops working immediately; the new one is shown once. */
devicesRouter.post('/:id/key', asyncH(async (req, res) => {
  const apiKey = newDeviceKey();
  const rows = await q('UPDATE devices SET api_key_hash=$2 WHERE id=$1 RETURNING id', [req.params.id, hashKey(apiKey)]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  res.json({ apiKey });
}));

devicesRouter.delete('/:id', asyncH(async (req, res) => {
  const rows = await q('DELETE FROM devices WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  const id = String(req.params.id);
  await redis.del(keys.hb(id), keys.latest(id), keys.recent(id));
  res.status(204).end();
}));

devicesRouter.get('/:id/telemetry', asyncH(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit ?? 120));
  const rows = await q(
    `SELECT ts, temperature, cpu, memory, battery, signal FROM telemetry WHERE device_id=$1 ORDER BY ts DESC LIMIT $2`,
    [req.params.id, limit],
  );
  res.json(rows.reverse());
}));

devicesRouter.get('/:id/history', asyncH(async (req, res) => {
  const [alerts, incidents, updates] = await Promise.all([
    q(`SELECT * FROM alerts WHERE device_id=$1 ORDER BY created_at DESC LIMIT 15`, [req.params.id]),
    q(`SELECT * FROM security_incidents WHERE device_id=$1 ORDER BY created_at DESC LIMIT 10`, [req.params.id]),
    q(`SELECT * FROM firmware_updates WHERE device_id=$1 ORDER BY created_at DESC LIMIT 5`, [req.params.id]),
  ]);
  res.json({ alerts, incidents, updates });
}));

const RANGE_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };

/** Averaged history for the Activity workspace (about 150 points whatever the range). */
devicesRouter.get('/:id/readings', asyncH(async (req, res) => {
  const range = String(req.query.range ?? '1h');
  const secs = RANGE_SECONDS[range];
  if (!secs) throw new HttpError(400, 'range must be one of 15m, 1h, 6h, 24h');
  const bucket = Math.max(2, Math.ceil(secs / 150));
  res.json({
    rangeSeconds: secs,
    bucketSeconds: bucket,
    points: await q(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / $2::float8) * $2::float8) AS ts,
         avg(temperature)::real AS temperature, avg(cpu)::real AS cpu, avg(memory)::real AS memory,
         avg(battery)::real AS battery, avg(signal)::real AS signal
       FROM telemetry WHERE device_id=$1 AND ts > now() - make_interval(secs => $3::float8)
       GROUP BY 1 ORDER BY 1`,
      [req.params.id, bucket, secs],
    ),
  });
}));
