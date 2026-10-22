import { col, nextId, toApi } from '../mongo';
import { latestFirmwareByType } from './deviceQueries';
import { HttpError } from '../util';
import { publish } from './events';
import { recordMaintenance } from './maintenance';

/** Controlled (simulated) firmware rollout: progress ticks up, then the device version flips. */
export async function startUpdate(deviceId: string, toVersion?: string) {
  const found = await col('devices').findOne({ _id: deviceId as any }, { projection: { type: 1, firmwareVersion: 1, status: 1 } });
  if (!found) throw new HttpError(404, 'Device not found');
  const dev = { id: deviceId, type: found.type as string, firmwareVersion: found.firmwareVersion as string, status: found.status as string };
  if (dev.status === 'offline') throw new HttpError(409, 'Device is offline - cannot push firmware');

  const target = toVersion ?? (await latestFirmwareByType()).get(dev.type);
  if (!target) throw new HttpError(404, 'No firmware release available for this device type');
  if (target === dev.firmwareVersion) throw new HttpError(409, 'Device already runs this version');

  const release = await col('firmware_releases').findOne({ deviceType: dev.type, version: target });
  if (!release) throw new HttpError(404, `Version ${target} is not a known release for ${dev.type}`);

  const busy = await col('firmware_updates').findOne({ deviceId, status: 'in_progress' });
  if (busy) throw new HttpError(409, 'An update is already running for this device');

  const now = new Date();
  const doc = { _id: (await nextId('firmware_updates')) as any, deviceId, fromVersion: dev.firmwareVersion, toVersion: target, status: 'in_progress', progress: 0, createdAt: now, updatedAt: now };
  await col('firmware_updates').insertOne(doc);
  const upd = toApi(doc);
  publish('firmware', { deviceId });
  const willFail = Math.random() < 0.08; // simulated flaky flash
  let progress = 0;
  const timer = setInterval(async () => {
    try {
      progress = Math.min(100, progress + 15 + Math.floor(Math.random() * 15));
      if (willFail && progress >= 60) {
        clearInterval(timer);
        await col('firmware_updates').updateOne({ _id: upd!.id }, { $set: { status: 'failed', updatedAt: new Date() } });
      } else if (progress >= 100) {
        clearInterval(timer);
        await col('firmware_updates').updateOne({ _id: upd!.id }, { $set: { status: 'completed', progress: 100, updatedAt: new Date() } });
        await col('devices').updateOne({ _id: deviceId as any }, { $set: { firmwareVersion: target } });
        await recordMaintenance(deviceId, 'firmware', `Firmware updated ${dev.firmwareVersion} -> ${target}`, 'Controlled rollout completed successfully.');
      } else {
        await col('firmware_updates').updateOne({ _id: upd!.id }, { $set: { progress, updatedAt: new Date() } });
      }
      publish('firmware', { deviceId });
    } catch (e) {
      clearInterval(timer);
      console.error('[firmware]', e);
    }
  }, 1500);
  return upd;
}
