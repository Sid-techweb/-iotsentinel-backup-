import { q, q1 } from '../db';

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
  const existing = await q1<{ id: number }>(
    `SELECT id FROM alerts WHERE device_id=$1 AND type=$2 AND metric IS NOT DISTINCT FROM $3 AND status<>'resolved' LIMIT 1`,
    [a.deviceId, a.type, metric],
  );
  if (existing) {
    await q('UPDATE alerts SET severity=$2, message=$3, value=$4 WHERE id=$1', [existing.id, a.severity, a.message, a.value ?? null]);
    return;
  }
  await q(
    `INSERT INTO alerts (device_id, type, severity, metric, message, value) VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.deviceId, a.type, a.severity, metric, a.message, a.value ?? null],
  );
}

export async function clearAlerts(deviceId: string, type: RaiseInput['type'], metric: string | null = null) {
  await q(
    `UPDATE alerts SET status='resolved', resolved_at=now()
     WHERE device_id=$1 AND type=$2 AND metric IS NOT DISTINCT FROM $3 AND status<>'resolved'`,
    [deviceId, type, metric],
  );
}
