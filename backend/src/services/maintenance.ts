import { col, nextId, toApi, toApiList } from '../mongo';

export const MAINTENANCE_KINDS = ['inspection', 'repair', 'replacement', 'calibration', 'firmware', 'activation', 'note'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export interface Performer { id?: string | null; name?: string }

/** Add an entry to a machine's maintenance history (manual entries and automatic ones such as firmware updates). */
export async function recordMaintenance(
  deviceId: string, kind: MaintenanceKind, summary: string, details = '', by: Performer = {}, performedAt?: Date,
) {
  const doc = {
    _id: (await nextId('maintenance_records')) as any, deviceId, kind, summary, details,
    performedBy: by.id ?? null, performedByName: by.name ?? 'system', performedAt: performedAt ?? new Date(), createdAt: new Date(),
  };
  await col('maintenance_records').insertOne(doc);
  return toApi(doc);
}

export const listMaintenance = async (deviceId: string, limit = 100) =>
  toApiList(await col('maintenance_records').find({ deviceId }).sort({ performedAt: -1, _id: -1 }).limit(limit).toArray());
