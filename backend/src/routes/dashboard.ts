import { Router } from 'express';
import { z } from 'zod';
import { q, q1 } from '../db';
import { cached } from '../redis';
import { asyncH } from '../util';

export const dashboardRouter = Router();

/**
 * Aggregated fleet overview for devices that are in service (deactivated machines are reported
 * separately). Optionally limited to one machine type. Cached in Redis for a couple of seconds to
 * protect PostgreSQL from dashboard refreshes.
 */
dashboardRouter.get('/summary', asyncH(async (req, res) => {
  const { type } = z.object({ type: z.string().trim().max(40).optional() }).parse(req.query);
  res.json(await cached(`cache:dashboard:${type ?? 'all'}`, 2000, async () => {
    const tp = type ? [type] : [];
    const onlyType = type ? ' AND d.type = $1' : '';
    const [devices, inactive, alerts, incidents, firmware, alertTrend, activity] = await Promise.all([
      q(`SELECT d.status, count(*)::int AS count FROM devices d WHERE d.active${onlyType} GROUP BY d.status`, tp),
      q1<{ n: number }>(`SELECT count(*)::int AS n FROM devices d WHERE NOT d.active${onlyType}`, tp),
      q(`SELECT a.severity, a.type, count(*)::int AS count FROM alerts a JOIN devices d ON d.id=a.device_id
         WHERE a.status <> 'resolved' AND d.active${onlyType} GROUP BY a.severity, a.type`, tp),
      q(`SELECT i.severity, count(*)::int AS count FROM security_incidents i LEFT JOIN devices d ON d.id=i.device_id
         WHERE i.status <> 'resolved' AND (d.id IS NULL OR d.active)${type ? ' AND d.type = $1' : ''} GROUP BY i.severity`, tp),
      q1(`SELECT count(*)::int AS outdated FROM devices d
          WHERE d.active${onlyType} AND d.firmware_version <> COALESCE((SELECT r.version FROM firmware_releases r WHERE r.device_type=d.type ORDER BY r.released_at DESC, r.id DESC LIMIT 1), d.firmware_version)`, tp),
      q(`SELECT date_trunc('minute', a.created_at) AS minute, a.type, count(*)::int AS count FROM alerts a JOIN devices d ON d.id=a.device_id
         WHERE a.created_at > now() - interval '30 minutes' AND d.active${onlyType} GROUP BY 1, 2 ORDER BY 1`, tp),
      q(`SELECT * FROM (
           SELECT 'alert' AS kind, a.id, a.severity, a.message AS text, d.name AS device_name, a.created_at
             FROM alerts a JOIN devices d ON d.id=a.device_id WHERE d.active${onlyType}
           UNION ALL
           SELECT 'incident', i.id, i.severity, i.category || ' - ' || i.description, COALESCE(d.name,'-'), i.created_at
             FROM security_incidents i LEFT JOIN devices d ON d.id=i.device_id
            WHERE (d.id IS NULL OR d.active)${type ? ' AND d.type = $1' : ''}
         ) x ORDER BY created_at DESC LIMIT 12`, tp),
    ]);
    const count = (s: string) => (devices as any[]).find((d) => d.status === s)?.count ?? 0;
    return {
      type: type ?? null,
      totals: { online: count('online'), degraded: count('degraded'), offline: count('offline'), all: count('online') + count('degraded') + count('offline'), inactive: inactive?.n ?? 0 },
      alerts, incidents, firmwareOutdated: (firmware as any).outdated, alertTrend, activity,
      generatedAt: new Date().toISOString(),
    };
  }));
}));
