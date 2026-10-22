import { col, nextId } from '../mongo';
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
  const now = new Date();
  const row = { _id: (await nextId('security_incidents')) as any, deviceId: i.deviceId ?? null, category: i.category, severity: i.severity, description: i.description, status: 'open', createdAt: now, updatedAt: now };
  await col('security_incidents').insertOne(row);
  publish('incident', { id: row._id });
  if (i.severity === 'high' || i.severity === 'critical') {
    const dev = i.deviceId ? await col('devices').findOne({ _id: i.deviceId as any }, { projection: { name: 1 } }) : null;
    notify('incident.created', { incidentId: row._id, device: dev?.name ?? null, category: i.category, severity: i.severity, description: i.description },
      `[${i.severity.toUpperCase()}] Security incident: ${i.category}${dev ? ` on ${dev.name}` : ''} - ${i.description}`);
  }
  const { _id, ...rest } = row;
  return { id: _id as number, ...rest };
}
