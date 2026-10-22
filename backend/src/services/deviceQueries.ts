import { col, escapeRegex, toApi } from '../mongo';
import { compareVersions } from '../util';

export interface DeviceBrief { id: string; assetNo: number; name: string; type: string; simulated: boolean; active: boolean }

/** Device facts for a set of ids, keyed by id (the replacement for SQL joins on `devices`). */
export async function deviceBriefs(ids: string[]): Promise<Map<string, DeviceBrief>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const docs = await col('devices').find({ _id: { $in: unique as any[] } }, { projection: { assetNo: 1, name: 1, type: 1, simulated: 1, active: 1 } }).toArray();
  return new Map(docs.map((d) => [d._id as unknown as string, { id: d._id as unknown as string, assetNo: d.assetNo, name: d.name, type: d.type, simulated: !!d.simulated, active: d.active !== false }]));
}

/** Add deviceName / assetNo / deviceType (and optionally simulated) to rows that carry a deviceId. */
export async function withDevice<T extends { deviceId?: string | null }>(rows: T[]): Promise<(T & { deviceName: string | null; assetNo: number | null; deviceType: string | null; simulated: boolean | null })[]> {
  const map = await deviceBriefs(rows.map((r) => r.deviceId ?? ''));
  return rows.map((r) => {
    const d = r.deviceId ? map.get(r.deviceId) : undefined;
    return { ...r, deviceName: d?.name ?? null, assetNo: d?.assetNo ?? null, deviceType: d?.type ?? null, simulated: d ? d.simulated : null };
  });
}

/** Newest firmware version per machine type. */
export async function latestFirmwareByType(): Promise<Map<string, string>> {
  const rows = await col('firmware_releases').find({}).sort({ releasedAt: -1, _id: -1 }).toArray();
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.deviceType)) out.set(r.deviceType, r.version);
  return out;
}

export interface DeviceFilter { status?: string; active?: boolean; search?: string; ids?: string[]; type?: string }

/** The inventory row used by the devices list, detail and exports: the device plus open alerts and the latest firmware for its type. */
export async function listDevices(f: DeviceFilter = {}) {
  const filter: Record<string, unknown> = {};
  if (f.status) filter.status = f.status;
  if (f.active !== undefined) filter.active = f.active;
  if (f.type) filter.type = f.type;
  if (f.ids) filter._id = { $in: f.ids };
  if (f.search) {
    const rx = { $regex: escapeRegex(f.search), $options: 'i' };
    const asset = Number(f.search.replace(/^#/, '').trim());
    filter.$or = [{ name: rx }, { location: rx }, { type: rx }, ...(Number.isInteger(asset) ? [{ assetNo: asset }] : [])];
  }
  const docs = await col('devices').find(filter, { projection: { apiKeyHash: 0, apiKey: 0 } }).sort({ name: 1 }).toArray();
  if (!docs.length) return [];
  const ids = docs.map((d) => d._id as unknown as string);
  const [open, latest] = await Promise.all([
    col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, status: { $ne: 'resolved' } } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray(),
    latestFirmwareByType(),
  ]);
  const openBy = new Map(open.map((o) => [o._id as unknown as string, o.n as number]));
  return docs.map((d) => ({
    ...toApi(d)!,
    openAlerts: openBy.get(d._id as unknown as string) ?? 0,
    latestFirmware: latest.get(d.type) ?? null,
  }));
}

export async function getDeviceRow(id: string) {
  return (await listDevices({ ids: [id] }))[0];
}

export const isOutdated = (installed: string, latest: string | null) => (latest ? compareVersions(installed, latest) < 0 : false);
