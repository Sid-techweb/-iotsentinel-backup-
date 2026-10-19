import { q, q1 } from '../db';
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
  const existing = await q1<{ id: number; severity: string }>(
    `SELECT id, severity FROM alerts WHERE device_id=$1 AND type=$2 AND metric IS NOT DISTINCT FROM $3 AND status<>'resolved' LIMIT 1`,
    [a.deviceId, a.type, metric],
  );
  if (existing) {
    await q('UPDATE alerts SET severity=$2, message=$3, value=$4 WHERE id=$1', [existing.id, a.severity, a.message, a.value ?? null]);
    if (existing.severity !== a.severity) publish('alert', { id: existing.id });
    return;
  }
  const created = await q1<{ id: number }>(
    `INSERT INTO alerts (device_id, type, severity, metric, message, value) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [a.deviceId, a.type, a.severity, metric, a.message, a.value ?? null],
  );
  publish('alert', { id: created?.id });

  // page people only for what needs attention: critical alerts and model predictions
  const event = a.type === 'predictive' ? 'alert.predictive' : a.severity === 'critical' ? 'alert.critical' : null;
  if (event) {
    const dev = await q1<{ name: string; type: string }>('SELECT name, type FROM devices WHERE id=$1', [a.deviceId]);
    notify(event, { alertId: created?.id, device: dev?.name, deviceType: dev?.type, severity: a.severity, metric, value: a.value ?? null, message: a.message },
      `[${a.severity.toUpperCase()}] ${dev?.name ?? 'device'}: ${a.message}`);
  }
}

export async function clearAlerts(deviceId: string, type: RaiseInput['type'], metric: string | null = null) {
  const rows = await q(
    `UPDATE alerts SET status='resolved', resolved_at=now()
     WHERE device_id=$1 AND type=$2 AND metric IS NOT DISTINCT FROM $3 AND status<>'resolved' RETURNING id`,
    [deviceId, type, metric],
  );
  if (rows.length) publish('alert', { cleared: rows.length });
}
