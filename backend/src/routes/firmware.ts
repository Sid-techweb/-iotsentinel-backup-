import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
import { startUpdate } from '../services/firmwareUpdates';
import { asyncH, compareVersions, HttpError } from '../util';

export const firmwareRouter = Router();

firmwareRouter.get('/releases', asyncH(async (_req, res) => {
  res.json(await q(
    `SELECT r.*, (SELECT count(*)::int FROM devices d WHERE d.type=r.device_type AND d.firmware_version=r.version) AS device_count
     FROM firmware_releases r ORDER BY r.device_type, r.released_at DESC, r.id DESC`));
}));

firmwareRouter.post('/releases', asyncH(async (req, res) => {
  const b = z.object({
    deviceType: z.string().min(2),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    notes: z.string().max(300).default(''),
    securityPatch: z.boolean().default(false),
  }).parse(req.body);
  const dup = await q1('SELECT 1 FROM firmware_releases WHERE device_type=$1 AND version=$2', [b.deviceType, b.version]);
  if (dup) throw new HttpError(409, 'That release already exists');
  res.status(201).json(await q1(
    'INSERT INTO firmware_releases (device_type, version, notes, security_patch) VALUES ($1,$2,$3,$4) RETURNING *',
    [b.deviceType, b.version, b.notes, b.securityPatch]));
}));

/** Per-device firmware compliance. "Outdated" is a maintenance signal, not proof of a vulnerability. */
firmwareRouter.get('/compliance', asyncH(async (_req, res) => {
  const devices = await q<any>(
    `SELECT d.id, d.name, d.type, d.status, d.firmware_version AS current,
       (SELECT r.version FROM firmware_releases r WHERE r.device_type=d.type ORDER BY r.released_at DESC, r.id DESC LIMIT 1) AS latest
     FROM devices d ORDER BY d.type, d.name`);
  const patches = await q<any>(`SELECT device_type, version FROM firmware_releases WHERE security_patch`);
  res.json(devices.map((d) => {
    const missed = patches.filter((p) => p.deviceType === d.type && compareVersions(p.version, d.current) > 0).length;
    return { ...d, outdated: d.latest ? compareVersions(d.current, d.latest) < 0 : false, missedSecurityReleases: missed };
  }));
}));

firmwareRouter.get('/updates', asyncH(async (_req, res) => {
  res.json(await q(
    `SELECT u.*, d.name AS device_name, d.type AS device_type FROM firmware_updates u JOIN devices d ON d.id=u.device_id
     ORDER BY u.created_at DESC LIMIT 50`));
}));

firmwareRouter.post('/updates', asyncH(async (req, res) => {
  const b = z.object({ deviceId: z.string().uuid(), toVersion: z.string().optional() }).parse(req.body);
  res.status(201).json(await startUpdate(b.deviceId, b.toVersion));
}));

/** Roll the latest release out to every online, outdated device (one batch, staggered by the simulator). */
firmwareRouter.post('/updates/bulk', asyncH(async (_req, res) => {
  const targets = await q<any>(
    `SELECT d.id FROM devices d WHERE d.status <> 'offline'
       AND d.firmware_version <> COALESCE((SELECT r.version FROM firmware_releases r WHERE r.device_type=d.type ORDER BY r.released_at DESC, r.id DESC LIMIT 1), d.firmware_version)
       AND NOT EXISTS (SELECT 1 FROM firmware_updates u WHERE u.device_id=d.id AND u.status='in_progress')`);
  let started = 0;
  for (const t of targets) {
    try { await startUpdate(t.id); started++; } catch { /* skip devices that cannot update right now */ }
  }
  res.status(201).json({ started });
}));
