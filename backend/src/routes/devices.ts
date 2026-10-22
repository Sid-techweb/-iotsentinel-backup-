import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { col, deleteDeviceData, nextId, toApiList } from '../mongo';
import { getDeviceRow, isOutdated, listDevices } from '../services/deviceQueries';
import { METRIC_KEYS } from '../ml/metrics';
import { clearCache, keys, redis } from '../redis';
import { audit, ctxOf } from '../services/audit';
import { forgetDevice, getDeviceType } from '../services/deviceTypes';
import { publish } from '../services/events';
import { listMaintenance, MAINTENANCE_KINDS, recordMaintenance } from '../services/maintenance';
import { asyncH, hashKey, HttpError, newDeviceKey, toCsv } from '../util';

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

async function withLatest(rows: any[]) {
  const latest = rows.length ? await redis.mget(rows.map((r) => keys.latest(r.id))) : [];
  return rows.map((r, i) => ({
    ...r,
    outdated: isOutdated(r.firmwareVersion, r.latestFirmware),
    latest: latest[i] ? JSON.parse(latest[i]!) : null,
  }));
}

export const devicesRouter = Router();

devicesRouter.get('/', asyncH(async (req, res) => {
  const { status, q: search, active } = req.query as Record<string, string | undefined>;
  const rows = await listDevices({ status, active: active === 'true' ? true : active === 'false' ? false : undefined, search: search?.trim() || undefined });
  res.json(await withLatest(rows));
}));

devicesRouter.post('/', asyncH(async (req, res) => {
  const b = createSchema.parse(req.body);
  if (!(await getDeviceType(b.type))) throw new HttpError(400, `Unknown machine type "${b.type}" - create it under Machine Types first`);
  const apiKey = newDeviceKey();
  const id = crypto.randomUUID();
  try {
    await col('devices').insertOne({
      _id: id as any, assetNo: await nextId('assetNo'), name: b.name, type: b.type, location: b.location, ipAddress: b.ipAddress ?? null,
      firmwareVersion: b.firmwareVersion, status: 'offline', active: true, simulated: b.simulated, apiKeyHash: hashKey(apiKey), lastSeen: null, createdAt: new Date(),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, `A device named "${b.name}" already exists`);
    throw e;
  }
  const created = (await getDeviceRow(id))!;
  const row = { id };
  audit(ctxOf(req), 'device.create', 'device', row.id, { name: b.name, type: b.type, simulated: b.simulated });
  await clearCache('cache:dashboard');
  publish('device', { id: row.id });
  // the raw key is returned exactly once - only its hash is stored
  res.status(201).json({ ...(await withLatest([created]))[0], apiKey });
}));

/** Inventory as CSV (must be declared before '/:id'). */
devicesRouter.get('/export.csv', asyncH(async (_req, res) => {
  const rows = await withLatest(await listDevices());
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
  const row = await getDeviceRow(String(req.params.id));
  if (!row) throw new HttpError(404, 'Device not found');
  res.json((await withLatest([row]))[0]);
}));

/**
 * Edit a device. Deactivating takes it out of service: it stops being counted, predicted and swept for
 * missed heartbeats, its open alerts are closed and further telemetry is refused - but its history is kept.
 */
devicesRouter.patch('/:id', asyncH(async (req, res) => {
  const b = updateSchema.parse(req.body);
  const found = await col('devices').findOne({ _id: String(req.params.id) as any }, { projection: { name: 1, active: 1 } });
  if (!found) throw new HttpError(404, 'Device not found');
  const current = { id: found._id as unknown as string, name: found.name as string, active: found.active !== false };
  const set: Record<string, unknown> = {};
  if (b.name !== undefined) set.name = b.name;
  if (b.location !== undefined) set.location = b.location;
  if (b.ipAddress !== undefined) set.ipAddress = b.ipAddress;
  if (b.active !== undefined) set.active = b.active;
  if (Object.keys(set).length) {
    try { await col('devices').updateOne({ _id: current.id as any }, { $set: set }); } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, `A device named "${b.name}" already exists`);
      throw e;
    }
  }
  if (b.active !== undefined && b.active !== current.active) {
    if (!b.active) {
      await col('alerts').updateMany({ deviceId: current.id, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedAt: new Date() } });
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
  res.json((await withLatest([(await getDeviceRow(current.id))!]))[0]);
}));

/** Issue a new device key. The old one stops working immediately; the new one is shown once. */
devicesRouter.post('/:id/key', asyncH(async (req, res) => {
  const apiKey = newDeviceKey();
  const r = await col('devices').updateOne({ _id: String(req.params.id) as any }, { $set: { apiKeyHash: hashKey(apiKey) } });
  if (!r.matchedCount) throw new HttpError(404, 'Device not found');
  audit(ctxOf(req), 'device.key_rotate', 'device', req.params.id);
  res.json({ apiKey });
}));

devicesRouter.delete('/:id', asyncH(async (req, res) => {
  const id = String(req.params.id);
  const gone = await col('devices').findOne({ _id: id as any }, { projection: { name: 1 } });
  if (!gone) throw new HttpError(404, 'Device not found');
  await deleteDeviceData(id);
  await redis.del(keys.hb(id), keys.latest(id), keys.recent(id));
  forgetDevice(id);
  audit(ctxOf(req), 'device.delete', 'device', id, { name: gone.name });
  await clearCache('cache:dashboard');
  publish('device', { id });
  res.status(204).end();
}));

const SIGNAL_FIELDS = Object.fromEntries(METRIC_KEYS.map((k) => [k, 1]));

devicesRouter.get('/:id/telemetry', asyncH(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 120) || 120));
  const rows = await col('telemetry').find({ deviceId: String(req.params.id) }, { projection: { _id: 0, ts: 1, ...SIGNAL_FIELDS } }).sort({ ts: -1 }).limit(limit).toArray();
  res.json(rows.reverse());
}));

devicesRouter.get('/:id/history', asyncH(async (req, res) => {
  const deviceId = String(req.params.id);
  const [alerts, incidents, updates] = await Promise.all([
    col('alerts').find({ deviceId }).sort({ createdAt: -1 }).limit(15).toArray(),
    col('security_incidents').find({ deviceId }).sort({ createdAt: -1 }).limit(10).toArray(),
    col('firmware_updates').find({ deviceId }).sort({ createdAt: -1 }).limit(5).toArray(),
  ]);
  res.json({ alerts: toApiList(alerts), incidents: toApiList(incidents), updates: toApiList(updates) });
}));

const RANGE_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };

/** Averaged history for the Activity workspace (about 150 points whatever the range). */
devicesRouter.get('/:id/readings', asyncH(async (req, res) => {
  const range = String(req.query.range ?? '1h');
  const secs = RANGE_SECONDS[range];
  if (!secs) throw new HttpError(400, 'range must be one of 15m, 1h, 6h, 24h');
  const bucket = Math.max(2, Math.ceil(secs / 150));
  const bucketMs = bucket * 1000;
  const rows = await col('telemetry').aggregate([
    { $match: { deviceId: String(req.params.id), ts: { $gt: new Date(Date.now() - secs * 1000) } } },
    { $group: { _id: { $floor: { $divide: [{ $toLong: '$ts' }, bucketMs] } }, ...Object.fromEntries(METRIC_KEYS.map((k) => [k, { $avg: `$${k}` }])) } },
    { $sort: { _id: 1 } },
  ]).toArray();
  res.json({
    rangeSeconds: secs,
    bucketSeconds: bucket,
    points: rows.map((r) => ({ ts: new Date((r._id as number) * bucketMs), ...Object.fromEntries(METRIC_KEYS.map((k) => [k, r[k] ?? null])) })),
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
  if (!(await col('devices').findOne({ _id: String(req.params.id) as any }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Device not found');
  res.json(await listMaintenance(String(req.params.id)));
}));

devicesRouter.post('/:id/maintenance', asyncH(async (req, res) => {
  const b = maintenanceSchema.parse(req.body);
  if (!(await col('devices').findOne({ _id: String(req.params.id) as any }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Device not found');
  const when = b.performedAt ? new Date(b.performedAt) : undefined;
  if (when && when.getTime() > Date.now() + 86_400_000) throw new HttpError(400, 'performedAt cannot be in the future');
  const row = await recordMaintenance(String(req.params.id), b.kind, b.summary, b.details, { id: req.user?.id, name: req.user?.name }, when);
  audit(ctxOf(req), 'maintenance.add', 'device', req.params.id, { kind: b.kind, summary: b.summary });
  publish('device', { id: req.params.id });
  res.status(201).json(row);
}));

devicesRouter.delete('/:id/maintenance/:recordId', asyncH(async (req, res) => {
  const r = await col('maintenance_records').deleteOne({ _id: Number(req.params.recordId) as any, deviceId: String(req.params.id) });
  if (!r.deletedCount) throw new HttpError(404, 'Maintenance record not found');
  audit(ctxOf(req), 'maintenance.delete', 'device', req.params.id, { recordId: req.params.recordId });
  res.status(204).end();
}));
