import crypto from 'crypto';
import { config } from '../config';
import { pool, q, q1 } from '../db';
import { keys, RECENT_MAX, redis } from '../redis';
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
];

// type -> [version, notes, securityPatch][] oldest -> newest
const RELEASES: Record<string, [string, string, boolean][]> = {
  'Smart Sensor': [['1.0.0', 'Initial release', false], ['1.1.0', 'Improved sampling accuracy', false], ['1.2.0', 'TLS 1.3 support, fixes credential logging', true], ['1.3.0', 'Signed OTA updates, watchdog fix', true]],
  'Asset Tracker': [['2.0.0', 'Initial release', false], ['2.1.0', 'GPS power optimisation', false], ['2.2.0', 'Geofence fixes, hardened BLE pairing', true]],
  Gateway: [['3.1.0', 'Initial release', false], ['3.2.0', 'MQTT QoS improvements', false], ['3.3.0', 'Fixes remote admin auth bypass', true], ['3.4.0', 'Config signing, memory leak fix', true]],
  'IP Camera': [['4.0.0', 'Initial release', false], ['4.1.0', 'Disables legacy RTSP auth, new codec', true], ['4.2.0', 'Secure boot attestation', true]],
  'Smart Meter': [['1.3.0', 'Initial release', false], ['1.4.0', 'Billing accuracy', false], ['1.5.0', 'Encrypted uplink', true], ['1.6.0', 'Tamper-event reporting', true]],
  'Industrial Controller': [['5.0.0', 'Initial release', false], ['5.1.0', 'Modbus hardening', true], ['5.2.0', 'Scan-cycle jitter fixes', false], ['5.3.0', 'Signed logic downloads', true]],
};

const RULES: [string, '>' | '<', number, 'warning' | 'critical'][] = [
  ['temperature', '>', 70, 'warning'], ['temperature', '>', 85, 'critical'],
  ['cpu', '>', 85, 'warning'], ['cpu', '>', 95, 'critical'],
  ['memory', '>', 85, 'warning'], ['memory', '>', 95, 'critical'],
  ['battery', '<', 20, 'warning'], ['battery', '<', 10, 'critical'],
  ['signal', '<', -80, 'warning'], ['signal', '<', -90, 'critical'],
];

const HISTORY_POINTS = 100;

export async function seedIfEmpty() {
  const { count } = (await q1<{ count: number }>('SELECT count(*)::int AS count FROM devices'))!;
  if (count > 0) return;
  console.log('[seed] empty database - seeding demo fleet');

  for (const [metric, op, threshold, severity] of RULES) {
    await q('INSERT INTO rules (metric, operator, threshold, severity) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [metric, op, threshold, severity]);
  }

  let month = 4;
  for (const [type, list] of Object.entries(RELEASES)) {
    let i = 0;
    for (const [version, notes, sec] of list) {
      await q(
        `INSERT INTO firmware_releases (device_type, version, notes, security_patch, released_at) VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval)`,
        [type, version, notes, sec, String((list.length - i) * 35 + month)],
      );
      i++;
    }
    month += 3;
  }

  const ids: { id: string; type: string }[] = [];
  for (const [i, [name, type, location, fw]] of DEVICES.entries()) {
    const row = await q1<{ id: string }>(
      `INSERT INTO devices (name, type, location, ip_address, firmware_version, api_key, simulated)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,
      [name, type, location, `10.20.${Math.floor(i / 4)}.${10 + i}`, fw, crypto.randomBytes(16).toString('hex')],
    );
    ids.push({ id: row!.id, type });
  }

  // Backfill recent healthy history so charts and the predictor have data on first load.
  const now = Date.now();
  for (const d of ids) {
    const st = newState(d.id, d.type);
    const rows: any[] = [];
    const recent: string[] = [];
    for (let n = HISTORY_POINTS; n >= 1; n--) {
      const ts = new Date(now - n * config.simIntervalMs);
      const m = reading(st);
      rows.push([d.id, ts, m.temperature, m.cpu, m.memory, m.battery, m.signal]);
      recent.push(JSON.stringify({ ts: ts.getTime(), ...m }));
    }
    const values = rows.map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`).join(',');
    await pool.query(`INSERT INTO telemetry (device_id, ts, temperature, cpu, memory, battery, signal) VALUES ${values}`, rows.flat());
    await redis.del(keys.recent(d.id));
    await redis.lpush(keys.recent(d.id), ...recent.slice(-RECENT_MAX)); // oldest first in => newest ends up at head
    await redis.set(keys.latest(d.id), recent[recent.length - 1]);
  }

  const hoursAgo = (h: number) => `now() - interval '${h} hours'`;
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
    await q(
      `INSERT INTO security_incidents (device_id, category, severity, description, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5, ${hoursAgo(h)}, ${hoursAgo(Math.max(0, h - 2))})`,
      [ids[di].id, category, severity, description, status],
    );
  }
  console.log(`[seed] ${DEVICES.length} devices, ${HISTORY_POINTS} readings each`);
}
