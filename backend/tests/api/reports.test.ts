import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db';
import { ingest } from '../../src/services/ingest';
import { api, bearer, bootstrap, eventually, newDevice, newUser, uid } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
let viewer: Awaited<ReturnType<typeof newUser>>;
let real: { id: string; name: string; apiKey: string };
let sim: { id: string; name: string };
const type = 'Smart Sensor';

const binary = (r: any, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; r.on('data', (x: Buffer) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); };

/** CSV text with the BOM removed. */
const csvText = (body: Buffer) => body.toString('utf8').replace(/^﻿/, '');

beforeAll(async () => {
  await bootstrap();
  admin = await newUser('admin');
  viewer = await newUser('viewer');
  real = await newDevice(admin.token, type, `=SUM(1+1)-real-${uid()}`); // a name that spreadsheets would execute
  const s = await newDevice(admin.token, type, `sim-${uid()}`);
  await pool.query('UPDATE devices SET simulated = true WHERE id = $1', [s.id]);
  sim = s;
  for (let i = 0; i < 6; i++) {
    await ingest(real.id, { temperature: 40 + i, cpu: 30 + i });
    await ingest(sim.id, { temperature: 50 + i, cpu: 60 });
  }
  await api().post('/api/telemetry').set('x-api-key', real.apiKey).send({ cpu: 99 }); // opens a critical alert
  await api().post(`/api/devices/${real.id}/maintenance`).set(bearer(admin.token)).send({ kind: 'inspection', summary: 'Checked bearings', details: 'All fine' });
});

const get = (token: string, path: string) => api().get(`/api/reports${path}`).set(bearer(token));

describe('reports catalogue', () => {
  it('requires authentication', async () => {
    expect((await api().get('/api/reports')).status).toBe(401);
  });

  it('lists the eight required reports plus the knowledge-base inventory', async () => {
    const res = await get(viewer.token, '');
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['device-health', 'telemetry-history', 'alert-history', 'predictive-summary', 'machine-type-comparison', 'maintenance-history', 'model-performance', 'knowledge-base']));
    expect(res.body.every((r: any) => r.formats.includes('csv') && r.formats.includes('pdf'))).toBe(true);
  });

  it('returns 404 for an unknown report', async () => {
    expect((await get(admin.token, '/nope')).status).toBe(404);
  });
});

describe('report previews', () => {
  it.each(['device-health', 'telemetry-history', 'alert-history', 'maintenance-history', 'machine-type-comparison', 'model-performance', 'predictive-summary', 'knowledge-base'])(
    '%s returns columns, rows and a total',
    async (id) => {
      const res = await get(viewer.token, `/${id}?machineType=${encodeURIComponent(type)}`);
      expect(res.status).toBe(200);
      expect(res.body.columns.length).toBeGreaterThan(3);
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(res.body.rows.length);
      expect(res.body.generatedAt).toBeTruthy();
    },
  );

  it('device health shows each device with its latest reading and open alerts', async () => {
    const res = await get(admin.token, `/device-health?deviceId=${real.id}`);
    expect(res.body.total).toBe(1);
    const row = res.body.rows[0];
    expect(row.deviceName).toBe(real.name);
    expect(row.openAlerts).toBeGreaterThanOrEqual(1);
    expect(row.cpu).toBe(99);
    expect(row.simulated).toBe(false);
  });

  it('telemetry history honours the period and the device filter', async () => {
    const day = 86_400_000;
    const inRange = await get(admin.token, `/telemetry-history?deviceId=${real.id}&from=${new Date(Date.now() - day).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`);
    expect(inRange.body.total).toBeGreaterThanOrEqual(7);
    const past = await get(admin.token, `/telemetry-history?deviceId=${real.id}&from=${new Date(Date.now() - 3 * day).toISOString()}&to=${new Date(Date.now() - 2 * day).toISOString()}`);
    expect(past.body.total).toBe(0);
  });

  it('alert history lists the alert with its device and severity', async () => {
    const res = await get(admin.token, `/alert-history?deviceId=${real.id}`);
    expect(res.body.rows.some((r: any) => r.severity === 'critical' && r.metric === 'cpu')).toBe(true);
  });

  it('maintenance history lists recorded work', async () => {
    const res = await get(admin.token, `/maintenance-history?deviceId=${real.id}`);
    expect(res.body.rows.map((r: any) => r.summary)).toContain('Checked bearings');
  });

  it('machine type comparison counts devices per type and marks simulated ones', async () => {
    const res = await get(admin.token, `/machine-type-comparison?machineType=${encodeURIComponent(type)}`);
    const row = res.body.rows.find((r: any) => r.machineType === type);
    expect(row.devices).toBeGreaterThanOrEqual(2);
    expect(row.simulatedDevices).toBeGreaterThanOrEqual(1);
    const excluded = await get(admin.token, `/machine-type-comparison?machineType=${encodeURIComponent(type)}&includeSimulated=false`);
    expect(excluded.body.rows[0].simulatedDevices).toBe(0);
  });

  it('model performance includes the active version and its honest framing', async () => {
    const res = await get(admin.token, '/model-performance');
    expect(res.body.rows.some((r: any) => r.isActive)).toBe(true);
    expect(res.body.notes.join(' ')).toMatch(/not "equipment failed"|synthetic/i);
  });

  it('says when simulated devices are part of a report, and leaves them out on request', async () => {
    const all = await get(admin.token, `/device-health?machineType=${encodeURIComponent(type)}`);
    expect(all.body.notes.join(' ')).toMatch(/simulator/i);
    expect(all.body.rows.some((r: any) => r.simulated)).toBe(true);
    const only = await get(admin.token, `/device-health?machineType=${encodeURIComponent(type)}&includeSimulated=false`);
    expect(only.body.rows.every((r: any) => !r.simulated)).toBe(true);
  });

  it('rejects an invalid or oversized period', async () => {
    const now = Date.now();
    expect((await get(admin.token, `/alert-history?from=${new Date(now).toISOString()}&to=${new Date(now - 1000).toISOString()}`)).status).toBe(400);
    expect((await get(admin.token, `/alert-history?from=${new Date(now - 800 * 86_400_000).toISOString()}&to=${new Date(now).toISOString()}`)).status).toBe(400);
    expect((await get(admin.token, '/alert-history?deviceId=not-a-uuid')).status).toBe(400);
  });

  it('only lists knowledge-base documents the user may read', async () => {
    const tag = uid();
    await api().post('/api/knowledge').set(bearer(admin.token)).attach('file', Buffer.from(`private admin note ${tag}`), `admin-${tag}.txt`);
    const mine = await get(admin.token, '/knowledge-base');
    expect(mine.body.rows.some((r: any) => r.originalName === `admin-${tag}.txt`)).toBe(true);
    const theirs = await get(viewer.token, '/knowledge-base');
    expect(theirs.body.rows.some((r: any) => r.originalName === `admin-${tag}.txt`)).toBe(false);
  });
});

describe('CSV export', () => {
  it('streams a CSV with a header, one line per row and a BOM for Excel', async () => {
    const res = await get(viewer.token, `/telemetry-history/csv?deviceId=${real.id}`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="telemetry-history-\d{4}-\d{2}-\d{2}\.csv"/);
    expect((res.body as Buffer).subarray(0, 3).toString('hex')).toBe('efbbbf');
    const lines = csvText(res.body).trim().split('\r\n');
    expect(lines[0]).toContain('Time');
    expect(lines.length).toBeGreaterThanOrEqual(8); // header + 7 readings
  });

  it('neutralises spreadsheet formulas in device names', async () => {
    const res = await get(admin.token, `/device-health/csv?deviceId=${real.id}`).buffer(true).parse(binary);
    const text = csvText(res.body);
    expect(text).toContain(`'=SUM(1+1)`);
    expect(text).not.toMatch(/(^|,)=SUM/m);
  });

  it('marks simulated devices in the export', async () => {
    const res = await get(admin.token, `/device-health/csv?deviceId=${sim.id}`).buffer(true).parse(binary);
    const [header, row] = csvText(res.body).trim().split('\r\n');
    const col = header.split(',').indexOf('Simulated');
    expect(col).toBeGreaterThan(-1);
    expect(row.split(',')[col]).toBe('true');
  });

  it('writes an audit entry for each export without storing any data', async () => {
    await get(admin.token, `/alert-history/csv?deviceId=${real.id}`).buffer(true).parse(binary);
    const row = await eventually(async () => (await pool.query(`SELECT details FROM audit_logs WHERE action='report.export' AND entity_id='alert-history' ORDER BY id DESC LIMIT 1`)).rows[0]);
    expect(row.details).toMatchObject({ format: 'csv', deviceId: real.id });
    expect(JSON.stringify(row.details)).not.toContain('message');
  });

  it('streams more rows than one batch without loading them all at once', async () => {
    const id = (await newDevice(admin.token, type, `bulk-${uid()}`)).id;
    await pool.query(`INSERT INTO telemetry (device_id, ts, cpu) SELECT $1, now() - (g || ' seconds')::interval, 10 FROM generate_series(1, 4500) g`, [id]);
    const res = await get(admin.token, `/telemetry-history/csv?deviceId=${id}`).buffer(true).parse(binary);
    const lines = csvText(res.body).trim().split('\r\n');
    expect(lines.length).toBe(4501);
    const times = lines.slice(1).map((l) => l.split(',')[0]);
    expect(new Set(times).size).toBe(4500); // no row repeated or skipped across batches
  });
});

describe('PDF export', () => {
  it('produces a valid PDF', async () => {
    const res = await get(viewer.token, `/device-health/pdf?machineType=${encodeURIComponent(type)}`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(1500);
    expect(body.subarray(-1024).toString('latin1')).toContain('%%EOF');
  });

  it('paginates long reports across several pages', async () => {
    const id = (await newDevice(admin.token, type, `pdf-bulk-${uid()}`)).id;
    await pool.query(`INSERT INTO telemetry (device_id, ts, cpu) SELECT $1, now() - (g || ' seconds')::interval, 10 FROM generate_series(1, 300) g`, [id]);
    const res = await get(admin.token, `/telemetry-history/pdf?deviceId=${id}`).buffer(true).parse(binary);
    const pages = (res.body as Buffer).toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(2);
  });

  it('prints a valid PDF even when nothing matches', async () => {
    const res = await get(admin.token, `/alert-history/pdf?machineType=NoSuchType`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
