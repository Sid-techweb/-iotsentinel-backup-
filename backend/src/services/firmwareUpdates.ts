import { q, q1 } from '../db';
import { HttpError } from '../util';

/** Controlled (simulated) firmware rollout: progress ticks up, then the device version flips. */
export async function startUpdate(deviceId: string, toVersion?: string) {
  const dev = await q1<{ id: string; type: string; firmwareVersion: string; status: string }>(
    'SELECT id, type, firmware_version, status FROM devices WHERE id=$1', [deviceId],
  );
  if (!dev) throw new HttpError(404, 'Device not found');
  if (dev.status === 'offline') throw new HttpError(409, 'Device is offline - cannot push firmware');

  const target =
    toVersion ??
    (await q1<{ version: string }>(
      'SELECT version FROM firmware_releases WHERE device_type=$1 ORDER BY released_at DESC, id DESC LIMIT 1', [dev.type],
    ))?.version;
  if (!target) throw new HttpError(404, 'No firmware release available for this device type');
  if (target === dev.firmwareVersion) throw new HttpError(409, 'Device already runs this version');

  const release = await q1('SELECT 1 FROM firmware_releases WHERE device_type=$1 AND version=$2', [dev.type, target]);
  if (!release) throw new HttpError(404, `Version ${target} is not a known release for ${dev.type}`);

  const busy = await q1(`SELECT 1 FROM firmware_updates WHERE device_id=$1 AND status='in_progress'`, [deviceId]);
  if (busy) throw new HttpError(409, 'An update is already running for this device');

  const upd = await q1<{ id: number }>(
    `INSERT INTO firmware_updates (device_id, from_version, to_version) VALUES ($1,$2,$3) RETURNING *`,
    [deviceId, dev.firmwareVersion, target],
  );
  const willFail = Math.random() < 0.08; // simulated flaky flash
  let progress = 0;
  const timer = setInterval(async () => {
    try {
      progress = Math.min(100, progress + 15 + Math.floor(Math.random() * 15));
      if (willFail && progress >= 60) {
        clearInterval(timer);
        await q(`UPDATE firmware_updates SET status='failed', updated_at=now() WHERE id=$1`, [upd!.id]);
      } else if (progress >= 100) {
        clearInterval(timer);
        await q(`UPDATE firmware_updates SET status='completed', progress=100, updated_at=now() WHERE id=$1`, [upd!.id]);
        await q('UPDATE devices SET firmware_version=$2 WHERE id=$1', [deviceId, target]);
      } else {
        await q('UPDATE firmware_updates SET progress=$2, updated_at=now() WHERE id=$1', [upd!.id, progress]);
      }
    } catch (e) {
      clearInterval(timer);
      console.error('[firmware]', e);
    }
  }, 1500);
  return upd;
}
