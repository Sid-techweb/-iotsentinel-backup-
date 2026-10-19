import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
import { METRIC_KEYS } from '../ml/metrics';
import { clearCache, keys, redis } from '../redis';
import { audit, ctxOf } from '../services/audit';
import { forgetDevice, getDeviceType } from '../services/deviceTypes';
import { publish } from '../services/events';
import { listMaintenance, MAINTENANCE_KINDS, recordMaintenance } from '../services/maintenance';
import { asyncH, compareVersions, hashKey, HttpError, newDeviceKey, toCsv } from '../util';

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  type: z.string().trim().min(2).max(40),
  location: z.string().trim().max(60).default('Unassigned'),
  ipAddress: z.string().trim().max(45).optional(),
  firmwareVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'Use semantic version, e.g. 1.2.0'),
  simulated: z.boolean().default(false),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  location: z.string().trim().min(1).max(60).optional(),
  ipAddress: z.string().trim().max(45).nullable().optional(),
  active: z.boolean().optional(),
});

const LIST_SQL = `
  SELECT d.id, d.asset_no, d.name, d.type, d.location, d.ip_address, d.firmware_version, d.status, d.active, d.simulated, d.last_seen, d.created_at,
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
  const { status, q: search, active } = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (active === 'true' || active === 'false') { params.push(active === 'true'); where.push(`d.active = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const like = params.length;
    params.push(search.replace(/^#/, '').trim()); // "12" or "#12" finds asset number 12
    const exact = params.length;
    where.push(`(d.name ILIKE $${like} OR d.location ILIKE $${like} OR d.type ILIKE $${like} OR d.asset_no::text = $${exact})`);
  }
  const rows = await q(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.name`, params);
  res.json(await withLatest(rows));
}));

devicesRouter.post('/', asyncH(async (req, res) => {
  const b = createSchema.parse(req.body);
  if (!(await getDeviceType(b.type))) throw new HttpError(400, `Unknown machine type "${b.type}" - create it under Machine Types first`);
  const dup = await q1('SELECT 1 FROM devices WHERE name=$1', [b.name]);
  if (dup) throw new HttpError(409, `A device named "${b.name}" already exists`);
  const apiKey = newDeviceKey();
  const row = await q1(
    `INSERT INTO devices (name, type, location, ip_address, firmware_version, api_key_hash, simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [b.name, b.type, b.location, b.ipAddress ?? null, b.firmwareVersion, hashKey(apiKey), b.simulated],
  );
  const [created] = await q(`${LIST_SQL} WHERE d.id=$1`, [row.id]);
  audit(ctxOf(req), 'device.create', 'device', row.id, { name: b.name, type: b.type, simulated: b.simulated });
  await clearCache('cache:dashboard');
  publish('device', { id: row.id });
  // the raw key is returned exactly once - only its hash is stored
  res.status(201).json({ ...(await withLatest([created]))[0], apiKey });
}));

/** Inventory as CSV (must be declared before '/:id'). */
devicesRouter.get('/export.csv', asyncH(async (_req, res) => {
  const rows = await withLatest(await q(`${LIST_SQL} ORDER BY d.name`));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="devices.csv"');
  res.send(toCsv(rows.map((r: any) => ({ ...r, ...Object.fromEntries(Object.entries(r.latest ?? {}).filter(([k]) => k !== 'ts').map(([k, v]) => [`latest_${k}`, v])) })), [
    { key: 'assetNo', header: 'Asset no.' }, { key: 'name', header: 'Name' }, { key: 'type', header: 'Machine type' }, { key: 'location', header: 'Location' },
    { key: 'status', header: 'Status' }, { key: 'active', header: 'Active' }, { key: 'simulated', header: 'Simulated' },
    { key: 'firmwareVersion', header: 'Firmware' }, { key: 'latestFirmware', header: 'Latest firmware' },
    { key: 'outdated', header: 'Outdated' }, { key: 'openAlerts', header: 'Open alerts' }, { key: 'lastSeen', header: 'Last seen' },
    { key: 'latest_temperature', header: 'Temperature' }, { key: 'latest_cpu', header: 'CPU' }, { key: 'latest_memory', header: 'Memory' },
    { key: 'latest_battery', header: 'Battery' }, { key: 'latest_signal', header: 'Signal' }, { key: 'latest_vibration', header: 'Vibration' },
    { key: 'latest_pressure', header: 'Pressure' }, { key: 'latest_current', header: 'Current' },
  ]));
}));

devicesRouter.get('/:id', asyncH(async (req, res) => {
  const rows = await q(`${LIST_SQL} WHERE d.id=$1`, [req.params.id]).catch(() => []);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  res.json((await withLatest(rows))[0]);
}));

/**
 * Edit a device. Deactivating takes it out of service: it stops being counted, predicted and swept for
 * missed heartbeats, its open alerts are closed and further telemetry is refused - but its history is kept.
 */
devicesRouter.patch('/:id', asyncH(async (req, res) => {
  const b = updateSchema.parse(req.body);
  const current = await q1<{ id: string; name: string; active: boolean }>('SELECT id, name, active FROM devices WHERE id=$1', [req.params.id]).catch(() => undefined);
  if (!current) throw new HttpError(404, 'Device not found');
  if (b.name && b.name !== current.name && (await q1('SELECT 1 FROM devices WHERE name=$1 AND id<>$2', [b.name, current.id]))) {
    throw new HttpError(409, `A device named "${b.name}" already exists`);
  }
  await q(
    `UPDATE devices SET name=COALESCE($2,name), location=COALESCE($3,location),
       ip_address = CASE WHEN $4::boolean THEN $5 ELSE ip_address END, active=COALESCE($6,active) WHERE id=$1`,
    [current.id, b.name ?? null, b.location ?? null, b.ipAddress !== undefined, b.ipAddress ?? null, b.active ?? null],
  );
  if (b.active !== undefined && b.active !== current.active) {
    if (!b.active) {
      await q(`UPDATE alerts SET status='resolved', resolved_at=now() WHERE device_id=$1 AND status<>'resolved'`, [current.id]);
      await redis.del(keys.hb(current.id));
    }
    await recordMaintenance(current.id, 'activation', b.active ? 'Device reactivated' : 'Device deactivated (taken out of service)', '', { id: req.user?.id, name: req.user?.name });
    audit(ctxOf(req), b.active ? 'device.activate' : 'device.deactivate', 'device', current.id, { name: current.name });
    publish('alert');
  } else {
    audit(ctxOf(req), 'device.update', 'device', current.id, { changed: Object.keys(b) });
  }
  forgetDevice(current.id);
  await clearCache('cache:dashboard');
  publish('device', { id: current.id });
  const [row] = await q(`${LIST_SQL} WHERE d.id=$1`, [current.id]);
  res.json((await withLatest([row]))[0]);
}));

/** Issue a new device key. The old one stops working immediately; the new one is shown once. */
devicesRouter.post('/:id/key', asyncH(async (req, res) => {
  const apiKey = newDeviceKey();
  const rows = await q('UPDATE devices SET api_key_hash=$2 WHERE id=$1 RETURNING id', [req.params.id, hashKey(apiKey)]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  audit(ctxOf(req), 'device.key_rotate', 'device', req.params.id);
  res.json({ apiKey });
}));

devicesRouter.delete('/:id', asyncH(async (req, res) => {
  const rows = await q('DELETE FROM devices WHERE id=$1 RETURNING id, name', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  const id = String(req.params.id);
  await redis.del(keys.hb(id), keys.latest(id), keys.recent(id));
  forgetDevice(id);
  audit(ctxOf(req), 'device.delete', 'device', id, { name: rows[0].name });
  await clearCache('cache:dashboard');
  publish('device', { id });
  res.status(204).end();
}));

const SIGNAL_COLUMNS = METRIC_KEYS.join(', ');

devicesRouter.get('/:id/telemetry', asyncH(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 120) || 120));
  const rows = await q(
    `SELECT ts, ${SIGNAL_COLUMNS} FROM telemetry WHERE device_id=$1 ORDER BY ts DESC LIMIT $2`,
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
  const averages = METRIC_KEYS.map((k) => `avg(${k})::real AS ${k}`).join(', ');
  res.json({
    rangeSeconds: secs,
    bucketSeconds: bucket,
    points: await q(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / $2::float8) * $2::float8) AS ts, ${averages}
       FROM telemetry WHERE device_id=$1 AND ts > now() - make_interval(secs => $3::float8)
       GROUP BY 1 ORDER BY 1`,
      [req.params.id, bucket, secs],
    ),
  });
}));

/* ------------------------------------------------------------------ maintenance history */

const maintenanceSchema = z.object({
  kind: z.enum(MAINTENANCE_KINDS),
  summary: z.string().trim().min(3).max(200),
  details: z.string().trim().max(2000).default(''),
  performedAt: z.string().datetime().optional(),
});

devicesRouter.get('/:id/maintenance', asyncH(async (req, res) => {
  if (!(await q1('SELECT 1 FROM devices WHERE id=$1', [req.params.id]).catch(() => undefined))) throw new HttpError(404, 'Device not found');
  res.json(await listMaintenance(String(req.params.id)));
}));

devicesRouter.post('/:id/maintenance', asyncH(async (req, res) => {
  const b = maintenanceSchema.parse(req.body);
  if (!(await q1('SELECT 1 FROM devices WHERE id=$1', [req.params.id]).catch(() => undefined))) throw new HttpError(404, 'Device not found');
  const when = b.performedAt ? new Date(b.performedAt) : undefined;
  if (when && when.getTime() > Date.now() + 86_400_000) throw new HttpError(400, 'performedAt cannot be in the future');
  const row = await recordMaintenance(String(req.params.id), b.kind, b.summary, b.details, { id: req.user?.id, name: req.user?.name }, when);
  audit(ctxOf(req), 'maintenance.add', 'device', req.params.id, { kind: b.kind, summary: b.summary });
  publish('device', { id: req.params.id });
  res.status(201).json(row);
}));

devicesRouter.delete('/:id/maintenance/:recordId', asyncH(async (req, res) => {
  const rows = await q('DELETE FROM maintenance_records WHERE id=$1 AND device_id=$2 RETURNING id', [req.params.recordId, req.params.id]).catch(() => []);
  if (!rows.length) throw new HttpError(404, 'Maintenance record not found');
  audit(ctxOf(req), 'maintenance.delete', 'device', req.params.id, { recordId: req.params.recordId });
  res.status(204).end();
}));
