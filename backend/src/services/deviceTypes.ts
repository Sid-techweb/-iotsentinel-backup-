import { col } from '../mongo';
import { DEFAULT_BASELINE, METRIC_KEYS, MetricKey } from '../ml/metrics';

export interface DeviceType {
  id: number;
  name: string;
  description: string;
  metrics: MetricKey[];
  baselines: Partial<Record<MetricKey, number>>;
}

/** Machine types shipped with the demo. Each one reports only the signals it really has. */
export const DEFAULT_TYPES: { name: string; description: string; baselines: Partial<Record<MetricKey, number>> }[] = [
  { name: 'Smart Sensor', description: 'Battery-powered environmental sensor', baselines: { temperature: 28, cpu: 18, memory: 42, battery: 85, signal: -58 } },
  { name: 'Asset Tracker', description: 'Battery-powered location tracker', baselines: { temperature: 30, cpu: 20, memory: 40, battery: 78, signal: -66 } },
  { name: 'Gateway', description: 'Edge gateway aggregating field devices', baselines: { temperature: 46, cpu: 34, memory: 55, signal: -50 } },
  { name: 'IP Camera', description: 'Network video camera', baselines: { temperature: 50, cpu: 45, memory: 60, signal: -55 } },
  { name: 'Smart Meter', description: 'Utility metering unit', baselines: { temperature: 35, cpu: 15, memory: 38, signal: -62 } },
  { name: 'Industrial Controller', description: 'PLC controlling plant equipment', baselines: { temperature: 52, cpu: 40, memory: 58, signal: -52 } },
  { name: 'CNC Machine', description: 'Machine tool with vibration and motor-current sensing', baselines: { temperature: 55, cpu: 38, memory: 52, signal: -54, vibration: 3.2, current: 14 } },
  { name: 'Pump Station', description: 'Pump with pressure, vibration and current sensing', baselines: { temperature: 40, cpu: 22, memory: 45, signal: -60, vibration: 2.4, pressure: 5.5, current: 9 } },
];

let memo: { at: number; rows: DeviceType[] } | null = null;

const fromRow = (r: any): DeviceType => ({
  id: r._id,
  name: r.name,
  description: r.description,
  metrics: (r.metrics as string[]).filter((m): m is MetricKey => (METRIC_KEYS as readonly string[]).includes(m)),
  baselines: r.baselines ?? {},
});

export async function getDeviceTypes(): Promise<DeviceType[]> {
  if (memo && Date.now() - memo.at < 10_000) return memo.rows;
  const rows = (await col('device_types').find({}).sort({ name: 1 }).toArray()).map(fromRow);
  memo = { at: Date.now(), rows };
  return rows;
}

export const invalidateDeviceTypes = () => { memo = null; deviceTypeCache.clear(); };

export async function getDeviceType(name: string): Promise<DeviceType | undefined> {
  return (await getDeviceTypes()).find((t) => t.name === name);
}

/** Starting value for each signal a type reports (used by the simulator). */
export async function baselinesFor(typeName: string): Promise<Partial<Record<MetricKey, number>>> {
  const t = await getDeviceType(typeName);
  if (!t) return DEFAULT_TYPES.find((d) => d.name === typeName)?.baselines ?? { temperature: 40, cpu: 30, memory: 50, signal: -60 };
  const out: Partial<Record<MetricKey, number>> = {};
  for (const m of t.metrics) out[m] = t.baselines[m] ?? DEFAULT_BASELINE[m];
  return out;
}

const deviceTypeCache = new Map<string, { type: string; at: number }>();

/** Which machine type a device belongs to (cached briefly: it is needed on every reading). */
export async function deviceTypeOf(deviceId: string): Promise<string | null> {
  const hit = deviceTypeCache.get(deviceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.type;
  const row = await col('devices').findOne({ _id: deviceId as any }, { projection: { type: 1 } });
  if (!row) return null;
  deviceTypeCache.set(deviceId, { type: row.type, at: Date.now() });
  return row.type;
}

export const forgetDevice = (deviceId: string) => { deviceTypeCache.delete(deviceId); };
