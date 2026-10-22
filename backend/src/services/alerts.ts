import { col, nextId } from '../mongo';
import { publish } from './events';
import { notify } from './webhooks';

export interface RaiseInput {
  deviceId: string;
  type: 'threshold' | 'heartbeat' | 'predictive';
  severity: 'info' | 'warning' | 'critical';
  metric?: string | null;
  message: string;
  value?: number | null;
}

/** Open an alert, or refresh the existing unresolved one for the same device/type/metric. */
export async function raiseAlert(a: RaiseInput) {
  const metric = a.metric ?? null;
  const existing = await col('alerts').findOne({ deviceId: a.deviceId, type: a.type, metric, status: { $ne: 'resolved' } });
  if (existing) {
    await col('alerts').updateOne({ _id: existing._id }, { $set: { severity: a.severity, message: a.message, value: a.value ?? null } });
    if (existing.severity !== a.severity) publish('alert', { id: existing._id });
    return;
  }
  const id = await nextId('alerts');
  await col('alerts').insertOne({
    _id: id as any, deviceId: a.deviceId, type: a.type, severity: a.severity, metric, message: a.message, value: a.value ?? null,
    status: 'open', createdAt: new Date(), resolvedAt: null,
  });
  publish('alert', { id });

  // page people only for what needs attention: critical alerts and model predictions
  const event = a.type === 'predictive' ? 'alert.predictive' : a.severity === 'critical' ? 'alert.critical' : null;
  if (event) {
    const dev = await col('devices').findOne({ _id: a.deviceId as any }, { projection: { name: 1, type: 1 } });
    notify(event, { alertId: id, device: dev?.name, deviceType: dev?.type, severity: a.severity, metric, value: a.value ?? null, message: a.message },
      `[${a.severity.toUpperCase()}] ${dev?.name ?? 'device'}: ${a.message}`);
  }
}

export async function clearAlerts(deviceId: string, type: RaiseInput['type'], metric: string | null = null) {
  const r = await col('alerts').updateMany({ deviceId, type, metric, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedAt: new Date() } });
  if (r.modifiedCount) publish('alert', { cleared: r.modifiedCount });
}
