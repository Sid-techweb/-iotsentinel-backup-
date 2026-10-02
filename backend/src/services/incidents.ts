import { q1 } from '../db';

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
  return q1(
    `INSERT INTO security_incidents (device_id, category, severity, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [i.deviceId ?? null, i.category, i.severity, i.description],
  );
}
