import { q, q1 } from '../db';

export const MAINTENANCE_KINDS = ['inspection', 'repair', 'replacement', 'calibration', 'firmware', 'activation', 'note'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export interface Performer { id?: string | null; name?: string }

/** Add an entry to a machine's maintenance history (manual entries and automatic ones such as firmware updates). */
export async function recordMaintenance(
  deviceId: string, kind: MaintenanceKind, summary: string, details = '', by: Performer = {}, performedAt?: Date,
) {
  return q1(
    `INSERT INTO maintenance_records (device_id, kind, summary, details, performed_by, performed_by_name, performed_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now())) RETURNING *`,
    [deviceId, kind, summary, details, by.id ?? null, by.name ?? 'system', performedAt ?? null],
  );
}

export const listMaintenance = (deviceId: string, limit = 100) =>
  q('SELECT * FROM maintenance_records WHERE device_id=$1 ORDER BY performed_at DESC, id DESC LIMIT $2', [deviceId, limit]);
