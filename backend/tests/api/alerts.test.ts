import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { col } from '../../src/mongo';
import { ingest } from '../../src/services/ingest';
import { sweepOnce } from '../../src/services/sweeper';
import { keys, redis } from '../../src/redis';
import { api, bearer, bootstrap, newDevice, newUser } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });

const alertsFor = async (deviceId: string, status?: string) =>
  (await api().get(`/api/alerts?deviceId=${deviceId}${status ? `&status=${status}` : ''}`).set(bearer(admin.token))).body as any[];

describe('rule-based alerts', () => {
  it('raises a threshold alert when a limit is crossed and clears it when the value recovers', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 97 });
    const open = await alertsFor(dev.id, 'active');
    const cpu = open.find((a) => a.type === 'threshold' && a.metric === 'cpu');
    expect(cpu).toMatchObject({ severity: 'critical', status: 'open' });
    expect(cpu.message).toContain('critical limit');
    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.status).toBe('degraded');

    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 20 });
    expect((await alertsFor(dev.id, 'active')).some((a) => a.metric === 'cpu')).toBe(false);
    expect((await alertsFor(dev.id, 'resolved')).some((a) => a.metric === 'cpu')).toBe(true);
    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.status).toBe('online');
  });

  it('does not duplicate an alert that is already open', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    for (let i = 0; i < 3; i++) await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ memory: 90 + i });
    const open = (await alertsFor(dev.id, 'active')).filter((a) => a.type === 'threshold' && a.metric === 'memory');
    expect(open).toHaveLength(1);
  });

  it('uses the limits of the device’s machine type', async () => {
    // CNC Machines have their own temperature limit (warning at 75 C); the default is 70 C
    const cnc = await newDevice(admin.token, 'CNC Machine');
    const sensor = await newDevice(admin.token, 'Smart Sensor');
    await api().post('/api/telemetry').set('x-api-key', cnc.apiKey).send({ temperature: 72 });
    await api().post('/api/telemetry').set('x-api-key', sensor.apiKey).send({ temperature: 72 });
    expect((await alertsFor(cnc.id, 'active')).some((a) => a.metric === 'temperature' && a.type === 'threshold')).toBe(false);
    expect((await alertsFor(sensor.id, 'active')).some((a) => a.metric === 'temperature' && a.type === 'threshold')).toBe(true);
  });

  it('lets an admin acknowledge and resolve alerts; viewers cannot', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 99 });
    const alert = (await alertsFor(dev.id, 'active'))[0];
    const viewer = await newUser('viewer');
    expect((await api().patch(`/api/alerts/${alert.id}`).set(bearer(viewer.token)).send({ status: 'acknowledged' })).status).toBe(403);
    expect((await api().patch(`/api/alerts/${alert.id}`).set(bearer(admin.token)).send({ status: 'acknowledged' })).body.status).toBe('acknowledged');
    expect((await api().patch(`/api/alerts/${alert.id}`).set(bearer(admin.token)).send({ status: 'resolved' })).body.status).toBe('resolved');
    expect((await api().patch(`/api/alerts/999999`).set(bearer(admin.token)).send({ status: 'resolved' })).status).toBe(404);
    expect((await api().patch(`/api/alerts/${alert.id}`).set(bearer(admin.token)).send({ status: 'bogus' })).status).toBe(400);
  });

  it('exports alerts as CSV', async () => {
    const res = await api().get('/api/alerts/export.csv?status=active').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toBe('ID,Raised,Severity,Type,Device,Metric,Message,Status,Resolved');
  });
});

describe('predictive alerts', () => {
  it('warns before the limit is reached when a metric climbs steadily', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor'); // temperature warning limit: 70
    const start = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) await ingest(dev.id, { temperature: 40 + i * 1.3 }, new Date(start + i * 2000)); // ends at 64.7 - still under the limit

    const all = await alertsFor(dev.id);
    const predictive = all.find((a) => a.type === 'predictive' && a.metric === 'temperature');
    expect(predictive).toBeTruthy();
    expect(predictive.message).toMatch(/trending to 70/);
    expect(all.some((a) => a.type === 'threshold' && a.metric === 'temperature')).toBe(false); // nothing has actually breached yet
  });

  it('stays quiet for a healthy, steady device', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    const start = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) await ingest(dev.id, { temperature: 40 + (i % 2) * 0.3, cpu: 20 + (i % 3) }, new Date(start + i * 2000));
    expect((await alertsFor(dev.id)).filter((a) => a.type === 'predictive')).toHaveLength(0);
  });

  it('shows the device in the fleet risk ranking and in its own forecast', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    const start = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) await ingest(dev.id, { temperature: 40 + i * 1.3 }, new Date(start + i * 2000));
    const fleet = (await api().get('/api/anomaly/predictions').set(bearer(admin.token))).body as any[];
    const mine = fleet.find((d) => d.deviceId === dev.id);
    expect(mine.level).toBe('high');
    expect(mine.topMetric).toBe('temperature');
    const detail = (await api().get(`/api/anomaly/predictions/${dev.id}`).set(bearer(admin.token))).body;
    expect(detail.prediction.metrics[0].forecast.length).toBeGreaterThan(5);
  });
});

describe('missed heartbeats', () => {
  it('marks a silent device offline with a critical alert, and recovers when it reports again', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send();
    await redis.del(keys.hb(dev.id)); // the heartbeat key expired
    expect(await sweepOnce()).toBeGreaterThanOrEqual(1);

    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.status).toBe('offline');
    const open = await alertsFor(dev.id, 'active');
    expect(open.find((a) => a.type === 'heartbeat')).toMatchObject({ severity: 'critical' });

    await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send();
    expect((await alertsFor(dev.id, 'active')).some((a) => a.type === 'heartbeat')).toBe(false);
    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.status).toBe('online');
  });

  it('leaves healthy devices alone', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send();
    await sweepOnce();
    expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.status).toBe('online');
  });
});

describe('data retention', () => {
  it('keeps the retention window configurable', () => {
    expect(config.retentionDays).toBeGreaterThan(0);
  });

  it('expires old telemetry with a MongoDB TTL index set to the retention window', async () => {
    const indexes = await col('telemetry').indexes();
    const ttl = indexes.find((i) => i.key?.ts === 1 && i.expireAfterSeconds !== undefined);
    expect(ttl?.expireAfterSeconds).toBe(config.retentionDays * 86_400);
  });
});
