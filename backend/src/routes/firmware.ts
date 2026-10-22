import { Router } from 'express';
import { z } from 'zod';
import { col, nextId, toApi, toApiList } from '../mongo';
import { latestFirmwareByType, withDevice } from '../services/deviceQueries';
import { startUpdate } from '../services/firmwareUpdates';
import { audit, ctxOf } from '../services/audit';
import { asyncH, compareVersions, HttpError } from '../util';

export const firmwareRouter = Router();

firmwareRouter.get('/releases', asyncH(async (_req, res) => {
  const [releases, counts] = await Promise.all([
    col('firmware_releases').find({}).toArray(),
    col('devices').aggregate([{ $group: { _id: { type: '$type', version: '$firmwareVersion' }, n: { $sum: 1 } } }]).toArray(),
  ]);
  const count = (type: string, version: string) => counts.find((c) => c._id.type === type && c._id.version === version)?.n ?? 0;
  res.json(toApiList(releases)
    .sort((a, b) => a.deviceType.localeCompare(b.deviceType) || +new Date(b.releasedAt) - +new Date(a.releasedAt) || b.id - a.id)
    .map((r) => ({ ...r, deviceCount: count(r.deviceType, r.version) })));
}));

firmwareRouter.post('/releases', asyncH(async (req, res) => {
  const b = z.object({
    deviceType: z.string().min(2),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    notes: z.string().max(300).default(''),
    securityPatch: z.boolean().default(false),
  }).parse(req.body);
  const doc = { _id: (await nextId('firmware_releases')) as any, deviceType: b.deviceType, version: b.version, notes: b.notes, securityPatch: b.securityPatch, releasedAt: new Date() };
  try { await col('firmware_releases').insertOne(doc); } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'That release already exists');
    throw e;
  }
  res.status(201).json(toApi(doc));
}));

/** Per-device firmware compliance. "Outdated" is a maintenance signal, not proof of a vulnerability. */
firmwareRouter.get('/compliance', asyncH(async (_req, res) => {
  const [docs, releases, latest] = await Promise.all([
    col('devices').find({}, { projection: { name: 1, type: 1, status: 1, firmwareVersion: 1 } }).toArray(),
    col('firmware_releases').find({ securityPatch: true }).toArray(),
    latestFirmwareByType(),
  ]);
  const rows = docs.map((d) => ({ id: d._id as unknown as string, name: d.name as string, type: d.type as string, status: d.status as string, current: d.firmwareVersion as string, latest: latest.get(d.type) ?? null }));
  rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  res.json(rows.map((d) => {
    const missed = releases.filter((p) => p.deviceType === d.type && compareVersions(p.version, d.current) > 0).length;
    return { ...d, outdated: d.latest ? compareVersions(d.current, d.latest) < 0 : false, missedSecurityReleases: missed };
  }));
}));

firmwareRouter.get('/updates', asyncH(async (_req, res) => {
  res.json(await withDevice(toApiList(await col('firmware_updates').find({}).sort({ createdAt: -1 }).limit(50).toArray())));
}));

firmwareRouter.post('/updates', asyncH(async (req, res) => {
  const b = z.object({ deviceId: z.string().uuid(), toVersion: z.string().optional() }).parse(req.body);
  const upd = await startUpdate(b.deviceId, b.toVersion);
  audit(ctxOf(req), 'firmware.update', 'device', b.deviceId, { toVersion: b.toVersion ?? 'latest' });
  res.status(201).json(upd);
}));

/** Roll the latest release out to every online, outdated device (one batch, staggered by the simulator). */
firmwareRouter.post('/updates/bulk', asyncH(async (req, res) => {
  const [devices, latest, running] = await Promise.all([
    col('devices').find({ status: { $ne: 'offline' } }, { projection: { type: 1, firmwareVersion: 1 } }).toArray(),
    latestFirmwareByType(),
    col('firmware_updates').distinct('deviceId', { status: 'in_progress' }),
  ]);
  const busy = new Set(running as string[]);
  const targets = devices.filter((d) => latest.has(d.type) && latest.get(d.type) !== d.firmwareVersion && !busy.has(d._id as unknown as string)).map((d) => ({ id: d._id as unknown as string }));
  let started = 0;
  for (const t of targets) {
    try { await startUpdate(t.id); started++; } catch { /* skip devices that cannot update right now */ }
  }
  audit(ctxOf(req), 'firmware.bulk_update', null, null, { started });
  res.status(201).json({ started });
}));
