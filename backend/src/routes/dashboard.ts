import { Router } from 'express';
import { z } from 'zod';
import { col } from '../mongo';
import { latestFirmwareByType } from '../services/deviceQueries';
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
    const scope = type ? { type } : {};
    const devices = await col('devices').find(scope, { projection: { name: 1, status: 1, active: 1, type: 1, firmwareVersion: 1 } }).toArray();
    const inService = devices.filter((d) => d.active !== false);
    const ids = inService.map((d) => d._id as unknown as string);
    const names = new Map(inService.map((d) => [d._id as unknown as string, d.name as string]));
    const since = new Date(Date.now() - 30 * 60_000);

    const [alerts, incidentRows, alertTrend, recentAlerts, recentIncidents, latest] = await Promise.all([
      col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, status: { $ne: 'resolved' } } }, { $group: { _id: { severity: '$severity', type: '$type' }, count: { $sum: 1 } } }]).toArray(),
      col('security_incidents').find({ status: { $ne: 'resolved' } }).toArray(),
      col('alerts').aggregate([
        { $match: { deviceId: { $in: ids }, createdAt: { $gt: since } } },
        { $group: { _id: { minute: { $dateTrunc: { date: '$createdAt', unit: 'minute' } }, type: '$type' }, count: { $sum: 1 } } },
        { $sort: { '_id.minute': 1 } },
      ]).toArray(),
      col('alerts').find({ deviceId: { $in: ids } }).sort({ createdAt: -1 }).limit(12).toArray(),
      col('security_incidents').find({}).sort({ createdAt: -1 }).limit(60).toArray(),
      latestFirmwareByType(),
    ]);

    // incidents count when they are not tied to a device, or the device is in service (and of the chosen type)
    const incidentVisible = (deviceId: string | null) => (deviceId ? names.has(deviceId) : !type);
    const bySeverity = new Map<string, number>();
    for (const i of incidentRows) if (incidentVisible(i.deviceId)) bySeverity.set(i.severity, (bySeverity.get(i.severity) ?? 0) + 1);

    const activity = [
      ...recentAlerts.map((a) => ({ kind: 'alert' as const, id: a._id as unknown as number, severity: a.severity as string, text: a.message as string, deviceName: names.get(a.deviceId) ?? '-', createdAt: a.createdAt as Date })),
      ...recentIncidents.filter((i) => incidentVisible(i.deviceId)).map((i) => ({ kind: 'incident' as const, id: i._id as unknown as number, severity: i.severity as string, text: `${i.category} - ${i.description}`, deviceName: i.deviceId ? names.get(i.deviceId) ?? '-' : '-', createdAt: i.createdAt as Date })),
    ].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 12);

    const count = (s: string) => inService.filter((d) => d.status === s).length;
    return {
      type: type ?? null,
      totals: { online: count('online'), degraded: count('degraded'), offline: count('offline'), all: inService.length, inactive: devices.length - inService.length },
      alerts: alerts.map((a) => ({ severity: a._id.severity, type: a._id.type, count: a.count })),
      incidents: [...bySeverity].map(([severity, count]) => ({ severity, count })),
      firmwareOutdated: inService.filter((d) => latest.has(d.type) && latest.get(d.type) !== d.firmwareVersion).length,
      alertTrend: alertTrend.map((a) => ({ minute: a._id.minute, type: a._id.type, count: a.count })),
      activity,
      generatedAt: new Date().toISOString(),
    };
  }));
}));
