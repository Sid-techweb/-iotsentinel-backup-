import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db';
import { api, bearer, bootstrap, newDevice, newUser, uid } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });

describe('devices and device keys', () => {
  it('shows a device key once and stores only its hash', async () => {
    const dev = await newDevice(admin.token);
    expect(dev.apiKey).toMatch(/^[0-9a-f]{32}$/);

    const detail = await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('apiKey');

    const row = (await pool.query('SELECT api_key, api_key_hash FROM devices WHERE id=$1', [dev.id])).rows[0];
    expect(row.api_key).toBeNull();
    expect(row.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.api_key_hash).not.toContain(dev.apiKey);
  });

  it('validates new devices', async () => {
    const dev = await newDevice(admin.token);
    const base = { name: `x-${uid()}`, type: 'Gateway', firmwareVersion: '1.0.0' };
    expect((await api().post('/api/devices').set(bearer(admin.token)).send({ ...base, name: dev.name })).status).toBe(409);
    expect((await api().post('/api/devices').set(bearer(admin.token)).send({ ...base, type: 'Flux Capacitor' })).status).toBe(400);
    expect((await api().post('/api/devices').set(bearer(admin.token)).send({ ...base, firmwareVersion: 'v1' })).status).toBe(400);
    expect((await api().post('/api/devices').set(bearer(admin.token)).send({ ...base, name: 'x' })).status).toBe(400);
  });

  it('accepts telemetry with the device key and reflects it in the device list', async () => {
    const dev = await newDevice(admin.token);
    const res = await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ temperature: 41.5, cpu: 22, memory: 48 });
    expect(res.status).toBe(202);

    const detail = await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token));
    expect(detail.body.status).toBe('online');
    expect(detail.body.latest).toMatchObject({ temperature: 41.5, cpu: 22, memory: 48, battery: null });

    const readings = await api().get(`/api/devices/${dev.id}/telemetry`).set(bearer(admin.token));
    expect(readings.body).toHaveLength(1);
  });

  it('accepts a bare heartbeat and the new signals (vibration, pressure, current)', async () => {
    const dev = await newDevice(admin.token, 'Pump Station');
    expect((await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send()).status).toBe(202);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ vibration: 2.1, pressure: 5.4, current: 9.2 })).status).toBe(202);
    const detail = await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token));
    expect(detail.body.latest).toMatchObject({ vibration: 2.1, pressure: 5.4, current: 9.2 });
  });

  it('rejects missing or wrong keys and out-of-range values', async () => {
    const dev = await newDevice(admin.token);
    expect((await api().post('/api/telemetry').send({ cpu: 1 })).status).toBe(401);
    expect((await api().post('/api/telemetry').set('x-api-key', 'f'.repeat(32)).send({ cpu: 1 })).status).toBe(401);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 500 })).status).toBe(400);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ signal: 12 })).status).toBe(400);
  });

  it('rotates a key: the old one stops working immediately', async () => {
    const dev = await newDevice(admin.token);
    const rotated = await api().post(`/api/devices/${dev.id}/key`).set(bearer(admin.token));
    expect(rotated.status).toBe(200);
    expect(rotated.body.apiKey).not.toBe(dev.apiKey);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 1 })).status).toBe(401);
    expect((await api().post('/api/telemetry').set('x-api-key', rotated.body.apiKey).send({ cpu: 1 })).status).toBe(202);
  });

  it('deletes a device together with its history', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 10 });
    expect((await api().delete(`/api/devices/${dev.id}`).set(bearer(admin.token))).status).toBe(204);
    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).status).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM telemetry WHERE device_id=$1', [dev.id])).rows[0].n).toBe(0);
  });

  it('exports the inventory as CSV', async () => {
    const dev = await newDevice(admin.token);
    const res = await api().get('/api/devices/export.csv').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('devices.csv');
    expect(res.text.split('\r\n')[0]).toContain('Machine type');
    expect(res.text).toContain(dev.name);
  });

  it('serves averaged history for the Activity screen and rejects unknown ranges', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 30 });
    const ok = await api().get(`/api/devices/${dev.id}/readings?range=15m`).set(bearer(admin.token));
    expect(ok.status).toBe(200);
    expect(ok.body.points.length).toBeGreaterThan(0);
    expect((await api().get(`/api/devices/${dev.id}/readings?range=9y`).set(bearer(admin.token))).status).toBe(400);
  });
});
