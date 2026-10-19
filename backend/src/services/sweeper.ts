import { config } from '../config';
import { q } from '../db';
import { keys, redis } from '../redis';
import { raiseAlert } from './alerts';
import { publish } from './events';

/**
 * One pass of missed-heartbeat detection. Each heartbeat sets a Redis key with a TTL;
 * when the key has expired the device has been silent for `offlineAfterMs`, so it is marked
 * offline and a critical alert is raised. Returns the number of devices that just went offline.
 */
export async function sweepOnce(): Promise<number> {
  const devices = await q<{ id: string; name: string; lastSeen: Date | null }>(
    `SELECT id, name, last_seen FROM devices WHERE status <> 'offline' AND active`,
  );
  let wentOffline = 0;
  for (const d of devices) {
    if (await redis.exists(keys.hb(d.id))) continue;
    await q(`UPDATE devices SET status='offline' WHERE id=$1`, [d.id]);
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
  // keep the telemetry table bounded
  const purge = () => q(`DELETE FROM telemetry WHERE ts < now() - make_interval(days => $1::int)`, [config.retentionDays]).catch((e) => console.error('[retention]', e));
  const purgeHistory = () => q(`DELETE FROM prediction_history WHERE created_at < now() - make_interval(days => $1::int)`, [config.predictionHistoryDays]).catch((e) => console.error('[retention]', e));
  purge();
  purgeHistory();
  setInterval(purge, 3600_000).unref();
  setInterval(purgeHistory, 3600_000).unref();
  return setInterval(run, Math.max(1000, config.offlineAfterMs / 4));
}
