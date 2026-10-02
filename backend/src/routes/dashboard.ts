import { Router } from 'express';
import { q, q1 } from '../db';
import { cached } from '../redis';
import { asyncH } from '../util';

export const dashboardRouter = Router();

/** Aggregated fleet overview. Cached in Redis for a couple of seconds to protect PostgreSQL from dashboard polling. */
dashboardRouter.get('/summary', asyncH(async (_req, res) => {
  res.json(await cached('cache:dashboard', 2000, async () => {
    const [devices, alerts, incidents, firmware, alertTrend, activity] = await Promise.all([
      q(`SELECT status, count(*)::int AS count FROM devices GROUP BY status`),
      q(`SELECT severity, type, count(*)::int AS count FROM alerts WHERE status <> 'resolved' GROUP BY severity, type`),
      q(`SELECT severity, count(*)::int AS count FROM security_incidents WHERE status <> 'resolved' GROUP BY severity`),
      q1(`SELECT count(*)::int AS outdated FROM devices d
          WHERE d.firmware_version <> COALESCE((SELECT r.version FROM firmware_releases r WHERE r.device_type=d.type ORDER BY r.released_at DESC, r.id DESC LIMIT 1), d.firmware_version)`),
      q(`SELECT date_trunc('minute', created_at) AS minute, type, count(*)::int AS count FROM alerts
         WHERE created_at > now() - interval '30 minutes' GROUP BY 1, 2 ORDER BY 1`),
      q(`SELECT 'alert' AS kind, a.id, a.severity, a.message AS text, d.name AS device_name, a.created_at
           FROM alerts a JOIN devices d ON d.id=a.device_id
         UNION ALL
         SELECT 'incident', i.id, i.severity, i.category || ' - ' || i.description, COALESCE(d.name,'-'), i.created_at
           FROM security_incidents i LEFT JOIN devices d ON d.id=i.device_id
         ORDER BY created_at DESC LIMIT 12`),
    ]);
    const count = (s: string) => (devices as any[]).find((d) => d.status === s)?.count ?? 0;
    return {
      totals: { online: count('online'), degraded: count('degraded'), offline: count('offline'), all: count('online') + count('degraded') + count('offline') },
      alerts, incidents, firmwareOutdated: (firmware as any).outdated, alertTrend, activity,
      generatedAt: new Date().toISOString(),
    };
  }));
}));
