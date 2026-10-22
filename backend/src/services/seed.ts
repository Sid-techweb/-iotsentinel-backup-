import { config } from '../config';
import crypto from 'crypto';
import { col, nextId } from '../mongo';
import { METRIC_KEYS } from '../ml/metrics';
import { keys, RECENT_MAX, redis } from '../redis';
import { hashKey, newDeviceKey } from '../util';
import { baselinesFor, DEFAULT_TYPES, invalidateDeviceTypes } from './deviceTypes';
import { invalidateRules } from './rules';
import { newState, reading } from './simulator';

const DEVICES: [string, string, string, string][] = [
  // name, type, location, firmware
  ['sensor-plantA-01', 'Smart Sensor', 'Plant A', '1.3.0'],
  ['sensor-plantA-02', 'Smart Sensor', 'Plant A', '1.2.0'],
  ['sensor-plantB-01', 'Smart Sensor', 'Plant B', '1.1.0'],
  ['tracker-wh-01', 'Asset Tracker', 'Warehouse', '2.1.0'],
  ['tracker-wh-02', 'Asset Tracker', 'Warehouse', '2.2.0'],
  ['gateway-hq-01', 'Gateway', 'HQ', '3.4.0'],
  ['gateway-plantA-01', 'Gateway', 'Plant A', '3.2.0'],
  ['cam-gate-01', 'IP Camera', 'Main Gate', '4.1.0'],
  ['cam-wh-02', 'IP Camera', 'Warehouse', '4.0.0'],
  ['cam-dc-01', 'IP Camera', 'Data Center', '4.1.0'],
  ['meter-hq-01', 'Smart Meter', 'HQ', '1.5.0'],
  ['meter-plantB-01', 'Smart Meter', 'Plant B', '1.4.0'],
  ['plc-plantA-01', 'Industrial Controller', 'Plant A', '5.2.0'],
  ['plc-plantB-01', 'Industrial Controller', 'Plant B', '5.1.0'],
  ['cnc-plantA-01', 'CNC Machine', 'Plant A', '6.1.0'],
  ['cnc-plantB-01', 'CNC Machine', 'Plant B', '6.0.0'],
  ['pump-station-01', 'Pump Station', 'Water Plant', '2.1.0'],
  ['pump-station-02', 'Pump Station', 'Water Plant', '2.0.0'],
];

// type -> [version, notes, securityPatch][] oldest -> newest
const RELEASES: Record<string, [string, string, boolean][]> = {
  'Smart Sensor': [['1.0.0', 'Initial release', false], ['1.1.0', 'Improved sampling accuracy', false], ['1.2.0', 'TLS 1.3 support, fixes credential logging', true], ['1.3.0', 'Signed OTA updates, watchdog fix', true]],
  'Asset Tracker': [['2.0.0', 'Initial release', false], ['2.1.0', 'GPS power optimisation', false], ['2.2.0', 'Geofence fixes, hardened BLE pairing', true]],
  Gateway: [['3.1.0', 'Initial release', false], ['3.2.0', 'MQTT QoS improvements', false], ['3.3.0', 'Fixes remote admin auth bypass', true], ['3.4.0', 'Config signing, memory leak fix', true]],
  'IP Camera': [['4.0.0', 'Initial release', false], ['4.1.0', 'Disables legacy RTSP auth, new codec', true], ['4.2.0', 'Secure boot attestation', true]],
  'Smart Meter': [['1.3.0', 'Initial release', false], ['1.4.0', 'Billing accuracy', false], ['1.5.0', 'Encrypted uplink', true], ['1.6.0', 'Tamper-event reporting', true]],
  'Industrial Controller': [['5.0.0', 'Initial release', false], ['5.1.0', 'Modbus hardening', true], ['5.2.0', 'Scan-cycle jitter fixes', false], ['5.3.0', 'Signed logic downloads', true]],
  'CNC Machine': [['6.0.0', 'Initial release', false], ['6.1.0', 'Spindle vibration filter', false], ['6.2.0', 'Signed G-code uploads', true]],
  'Pump Station': [['2.0.0', 'Initial release', false], ['2.1.0', 'Pressure sensor calibration', false], ['2.2.0', 'Hardened remote valve control', true]],
};

/** Default alert rules for every machine type. */
const RULES: [string, '>' | '<', number, 'warning' | 'critical'][] = [
  ['temperature', '>', 70, 'warning'], ['temperature', '>', 85, 'critical'],
  ['cpu', '>', 85, 'warning'], ['cpu', '>', 95, 'critical'],
  ['memory', '>', 85, 'warning'], ['memory', '>', 95, 'critical'],
  ['battery', '<', 20, 'warning'], ['battery', '<', 10, 'critical'],
  ['signal', '<', -80, 'warning'], ['signal', '<', -90, 'critical'],
  ['vibration', '>', 7, 'warning'], ['vibration', '>', 11, 'critical'],
  ['pressure', '>', 8, 'warning'], ['pressure', '>', 10, 'critical'],
  ['current', '>', 22, 'warning'], ['current', '>', 28, 'critical'],
];

/** Machine-specific limits that differ from the defaults. */
const OVERRIDES: [string, string, '>' | '<', number, 'warning' | 'critical'][] = [
  ['CNC Machine', 'temperature', '>', 75, 'warning'], ['CNC Machine', 'temperature', '>', 90, 'critical'],
  ['CNC Machine', 'vibration', '>', 6, 'warning'], ['CNC Machine', 'vibration', '>', 9, 'critical'],
  ['CNC Machine', 'current', '>', 20, 'warning'], ['CNC Machine', 'current', '>', 26, 'critical'],
  ['Pump Station', 'pressure', '>', 7.5, 'warning'], ['Pump Station', 'pressure', '>', 9.5, 'critical'],
  ['Pump Station', 'vibration', '>', 5, 'warning'], ['Pump Station', 'vibration', '>', 8, 'critical'],
];

const HISTORY_POINTS = 100;

/**
 * Idempotent reference data, safe to run on every boot: machine types, default rules,
 * per-type rule overrides and firmware releases. Returns the machine types added by this run.
 */
export async function ensureReferenceData(): Promise<string[]> {
  const added: string[] = [];
  for (const t of DEFAULT_TYPES) {
    const r = await col('device_types').updateOne(
      { name: t.name },
      { $setOnInsert: { _id: (await nextId('device_types')) as any, name: t.name, description: t.description, metrics: Object.keys(t.baselines), baselines: t.baselines, createdAt: new Date() } },
      { upsert: true },
    );
    if (r.upsertedCount) added.push(t.name);
  }
  const addRule = async (metric: string, operator: string, threshold: number, severity: string, deviceType: string | null) => {
    await col('rules').updateOne(
      { metric, severity, deviceType },
      { $setOnInsert: { _id: (await nextId('rules')) as any, metric, operator, threshold, severity, enabled: true, deviceType } },
      { upsert: true },
    );
  };
  for (const [metric, op, threshold, severity] of RULES) await addRule(metric, op, threshold, severity, null);
  // overrides are only created together with their machine type, so deleting one later sticks
  for (const [type, metric, op, threshold, severity] of OVERRIDES) {
    if (!added.includes(type)) continue;
    await addRule(metric, op, threshold, severity, type);
  }
  let month = 4;
  for (const [type, list] of Object.entries(RELEASES)) {
    let i = 0;
    for (const [version, notes, sec] of list) {
      const releasedAt = new Date(Date.now() - ((list.length - i) * 35 + month) * 86_400_000);
      await col('firmware_releases').updateOne(
        { deviceType: type, version },
        { $setOnInsert: { _id: (await nextId('firmware_releases')) as any, deviceType: type, version, notes, securityPatch: sec, releasedAt } },
        { upsert: true },
      );
      i++;
    }
    month += 3;
  }
  invalidateRules();
  invalidateDeviceTypes();
  return added;
}

/** Recent healthy history so charts and the predictor have data straight away. */
async function backfill(deviceId: string, type: string) {
  const st = newState(deviceId, type, await baselinesFor(type));
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const recent: string[] = [];
  for (let n = HISTORY_POINTS; n >= 1; n--) {
    const ts = new Date(now - n * config.simIntervalMs);
    const m = reading(st);
    rows.push({ deviceId, ts, ...Object.fromEntries(METRIC_KEYS.map((k) => [k, m[k]])) });
    recent.push(JSON.stringify({ ts: ts.getTime(), ...m }));
  }
  await col('telemetry').insertMany(rows as any[]);
  await redis.del(keys.recent(deviceId));
  await redis.lpush(keys.recent(deviceId), ...recent.slice(-RECENT_MAX)); // oldest first in => newest ends up at head
  await redis.set(keys.latest(deviceId), recent[recent.length - 1]);
}

async function addDevices(list: typeof DEVICES) {
  const created: { id: string; type: string }[] = [];
  for (const [i, [name, type, location, fw]] of list.entries()) {
    const id = crypto.randomUUID();
    const r = await col('devices').updateOne(
      { name },
      { $setOnInsert: {
        _id: id as any, assetNo: await nextId('assetNo'), name, type, location, ipAddress: `10.20.${Math.floor(i / 4)}.${10 + i}`, firmwareVersion: fw,
        status: 'offline', active: true, simulated: true, apiKeyHash: hashKey(newDeviceKey()), lastSeen: null, createdAt: new Date(),
      } },
      { upsert: true },
    );
    if (r.upsertedCount) { created.push({ id, type }); await backfill(id, type); }
  }
  return created;
}

export async function seedIfEmpty(newTypes: string[] = []) {
  const count = await col('devices').estimatedDocumentCount();
  if (count > 0) {
    // an existing installation gains demo machines for any machine type introduced by this upgrade
    const extra = DEVICES.filter(([, type]) => newTypes.includes(type));
    if (extra.length) {
      const created = await addDevices(extra);
      if (created.length) console.log(`[seed] added ${created.length} demo machines for new machine types`);
    }
    return;
  }
  console.log('[seed] empty database - seeding demo fleet');
  const ids = await addDevices(DEVICES);

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const incidents: [number, string, string, string, string, number][] = [
    [0, 'Brute-force login', 'high', '63 failed admin logins in 60s from 203.0.113.44', 'resolved', 52],
    [7, 'Unsigned firmware attempt', 'critical', 'Firmware image rejected: signature verification failed', 'investigating', 20],
    [8, 'Unexpected open port', 'medium', 'Port 2323/tcp opened outside the approved baseline', 'open', 9],
    [12, 'Configuration tampering', 'high', 'Configuration hash changed without an approved change request', 'investigating', 14],
    [5, 'Certificate expiring', 'low', 'Device TLS certificate expires in 6 days', 'open', 30],
    [9, 'Malformed / replayed packets', 'medium', '31 replayed MQTT frames dropped in the last minute', 'resolved', 40],
    [3, 'Unauthorized access', 'high', 'Successful login from an IP outside the allow-list', 'open', 5],
  ];
  for (const [di, category, severity, description, status, h] of incidents) {
    await col('security_incidents').insertOne({
      _id: (await nextId('security_incidents')) as any, deviceId: ids[di].id, category, severity, description, status,
      createdAt: hoursAgo(h), updatedAt: hoursAgo(Math.max(0, h - 2)),
    });
  }
  console.log(`[seed] ${ids.length} devices, ${HISTORY_POINTS} readings each`);
}
