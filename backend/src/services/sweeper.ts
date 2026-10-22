import { config } from '../config';
import { col } from '../mongo';
import { keys, redis } from '../redis';
import { raiseAlert } from './alerts';
import { publish } from './events';

/**
 * One pass of missed-heartbeat detection. Each heartbeat sets a Redis key with a TTL;
 * when the key has expired the device has been silent for `offlineAfterMs`, so it is marked
 * offline and a critical alert is raised. Returns the number of devices that just went offline.
 */
export async function sweepOnce(): Promise<number> {
  const devices = (await col('devices').find({ status: { $ne: 'offline' }, active: { $ne: false } }, { projection: { name: 1, lastSeen: 1 } }).toArray())
    .map((d) => ({ id: d._id as unknown as string, name: d.name as string, lastSeen: (d.lastSeen ?? null) as Date | null }));
  let wentOffline = 0;
  for (const d of devices) {
    if (await redis.exists(keys.hb(d.id))) continue;
    await col('devices').updateOne({ _id: d.id as any }, { $set: { status: 'offline' } });
    const silent = d.lastSeen ? Math.round((Date.now() - new Date(d.lastSeen).getTime()) / 1000) : null;
    await raiseAlert({
      deviceId: d.id, type: 'heartbeat', severity: 'critical',
      message: `No heartbeat from ${d.name}${silent ? ` for ${silent}s` : ''} (limit ${Math.round(config.offlineAfterMs / 1000)}s)`,
    });
    publish('device', { id: d.id });
    wentOffline++;
  }
  return wentOffline;
}

export function startSweeper() {
  const run = () => sweepOnce().catch((err) => console.error('[sweeper]', err));
  // telemetry is expired by a MongoDB TTL index (see mongo.ts); prediction history is pruned here
  const purgeHistory = () => col('prediction_history').deleteMany({ createdAt: { $lt: new Date(Date.now() - config.predictionHistoryDays * 86_400_000) } }).catch((e) => console.error('[retention]', e));
  purgeHistory();
  setInterval(purgeHistory, 3600_000).unref();
  return setInterval(run, Math.max(1000, config.offlineAfterMs / 4));
}
