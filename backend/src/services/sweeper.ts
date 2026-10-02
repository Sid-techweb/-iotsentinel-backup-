import { config } from '../config';
import { q } from '../db';
import { keys, redis } from '../redis';
import { raiseAlert } from './alerts';

/**
 * Missed-heartbeat detection. Each heartbeat sets a Redis key with a TTL;
 * when the key expires the device has been silent for `offlineAfterMs`.
 */
export function startSweeper() {
  const run = async () => {
    try {
      const devices = await q<{ id: string; name: string; lastSeen: Date | null }>(
        `SELECT id, name, last_seen FROM devices WHERE status <> 'offline'`,
      );
      for (const d of devices) {
        if (await redis.exists(keys.hb(d.id))) continue;
        await q(`UPDATE devices SET status='offline' WHERE id=$1`, [d.id]);
        const silent = d.lastSeen ? Math.round((Date.now() - new Date(d.lastSeen).getTime()) / 1000) : null;
        await raiseAlert({
          deviceId: d.id, type: 'heartbeat', severity: 'critical',
          message: `No heartbeat from ${d.name}${silent ? ` for ${silent}s` : ''} (limit ${Math.round(config.offlineAfterMs / 1000)}s)`,
        });
      }
    } catch (err) {
      console.error('[sweeper]', err);
    }
  };
  return setInterval(run, Math.max(1000, config.offlineAfterMs / 4));
}
