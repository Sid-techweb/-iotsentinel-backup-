import { q1 } from '../db';
import { publish } from './events';
import { notify } from './webhooks';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const INCIDENT_CATEGORIES = [
  'Brute-force login',
  'Unsigned firmware attempt',
  'Unexpected open port',
  'Certificate expiring',
  'Configuration tampering',
  'Malformed / replayed packets',
  'Unauthorized access',
] as const;

export async function createIncident(i: { deviceId?: string | null; category: string; severity: Severity; description: string }) {
  const row = await q1<{ id: number }>(
    `INSERT INTO security_incidents (device_id, category, severity, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [i.deviceId ?? null, i.category, i.severity, i.description],
  );
  publish('incident', { id: row?.id });
  if (i.severity === 'high' || i.severity === 'critical') {
    const dev = i.deviceId ? await q1<{ name: string }>('SELECT name FROM devices WHERE id=$1', [i.deviceId]) : undefined;
    notify('incident.created', { incidentId: row?.id, device: dev?.name ?? null, category: i.category, severity: i.severity, description: i.description },
      `[${i.severity.toUpperCase()}] Security incident: ${i.category}${dev ? ` on ${dev.name}` : ''} - ${i.description}`);
  }
  return row;
}
