import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, bootstrap, newDevice, newUser, uid } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });

describe('machine types', () => {
  it('ships machine types that each report their own signals', async () => {
    const types = (await api().get('/api/device-types').set(bearer(admin.token))).body as any[];
    const byName = Object.fromEntries(types.map((t) => [t.name, t.metrics]));
    expect(byName['Smart Sensor']).toContain('battery');
    expect(byName['Gateway']).not.toContain('battery');
    expect(byName['CNC Machine']).toEqual(expect.arrayContaining(['vibration', 'current']));
    expect(byName['Pump Station']).toContain('pressure');
  });

  it('creates, edits and deletes a custom machine type', async () => {
    const name = `Compressor ${uid()}`;
    const created = await api().post('/api/device-types').set(bearer(admin.token)).send({ name, description: 'Air compressor', metrics: ['temperature', 'pressure', 'pressure', 'vibration'] });
    expect(created.status).toBe(201);
    expect(created.body.metrics).toEqual(['temperature', 'pressure', 'vibration']); // duplicates removed

    expect((await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['cpu'] })).status).toBe(409);
    expect((await api().post('/api/device-types').set(bearer(admin.token)).send({ name: `Empty ${uid()}`, metrics: [] })).status).toBe(400);
    expect((await api().post('/api/device-types').set(bearer(admin.token)).send({ name: `Bad ${uid()}`, metrics: ['telepathy'] })).status).toBe(400);

    const edited = await api().put(`/api/device-types/${created.body.id}`).set(bearer(admin.token)).send({ metrics: ['temperature', 'current'] });
    expect(edited.body.metrics).toEqual(['temperature', 'current']);

    // devices can be registered under the new type...
    const dev = await newDevice(admin.token, name);
    // ...and then it cannot be deleted until they are gone
    const blocked = await api().delete(`/api/device-types/${created.body.id}`).set(bearer(admin.token));
    expect(blocked.status).toBe(409);
    await api().delete(`/api/devices/${dev.id}`).set(bearer(admin.token));
    expect((await api().delete(`/api/device-types/${created.body.id}`).set(bearer(admin.token))).status).toBe(204);
  });

  it('is admin-only to change', async () => {
    const viewer = await newUser('viewer');
    expect((await api().post('/api/device-types').set(bearer(viewer.token)).send({ name: 'Nope Type', metrics: ['cpu'] })).status).toBe(403);
    expect((await api().get('/api/device-types').set(bearer(viewer.token))).status).toBe(200);
  });
});

describe('per-type alert rules', () => {
  const find = (rules: any[], metric: string, severity: string) => rules.find((r) => r.metric === metric && r.severity === severity);

  it('returns the defaults, and a type’s view of them', async () => {
    const defaults = (await api().get('/api/rules').set(bearer(admin.token))).body as any[];
    expect(find(defaults, 'temperature', 'warning')).toMatchObject({ threshold: 70, deviceType: null });
    expect(defaults.length).toBeGreaterThanOrEqual(16);

    const cnc = (await api().get('/api/rules?deviceType=CNC%20Machine').set(bearer(admin.token))).body as any[];
    expect(find(cnc, 'temperature', 'warning')).toMatchObject({ threshold: 75, inherited: false });
    expect(find(cnc, 'cpu', 'warning')).toMatchObject({ threshold: 85, inherited: true });
    expect(cnc.some((r) => r.metric === 'battery')).toBe(false); // CNC machines have no battery
    expect((await api().get('/api/rules?deviceType=Nope').set(bearer(admin.token))).status).toBe(404);
  });

  it('creates an override, applies it only to that type, then resets it', async () => {
    const put = await api().put('/api/rules/override').set(bearer(admin.token)).send({ deviceType: 'IP Camera', metric: 'cpu', severity: 'warning', threshold: 60 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ threshold: 60, deviceType: 'IP Camera' });

    const cam = (await api().get('/api/rules?deviceType=IP%20Camera').set(bearer(admin.token))).body as any[];
    expect(find(cam, 'cpu', 'warning')).toMatchObject({ threshold: 60, inherited: false });
    const gateway = (await api().get('/api/rules?deviceType=Gateway').set(bearer(admin.token))).body as any[];
    expect(find(gateway, 'cpu', 'warning').threshold).toBe(85); // other types keep the default

    // it is enforced on ingest for that type
    const camera = await newDevice(admin.token, 'IP Camera');
    await api().post('/api/telemetry').set('x-api-key', camera.apiKey).send({ cpu: 65 });
    const alerts = (await api().get(`/api/alerts?deviceId=${camera.id}&status=active`).set(bearer(admin.token))).body as any[];
    expect(alerts.some((a) => a.type === 'threshold' && a.metric === 'cpu' && a.severity === 'warning')).toBe(true);

    // updating the same override again edits it rather than duplicating it
    const again = await api().put('/api/rules/override').set(bearer(admin.token)).send({ deviceType: 'IP Camera', metric: 'cpu', severity: 'warning', threshold: 65 });
    expect(again.body.id).toBe(put.body.id);

    expect((await api().delete(`/api/rules/${put.body.id}`).set(bearer(admin.token))).status).toBe(204);
    const after = (await api().get('/api/rules?deviceType=IP%20Camera').set(bearer(admin.token))).body as any[];
    expect(find(after, 'cpu', 'warning')).toMatchObject({ threshold: 85, inherited: true });
  });

  it('refuses to delete a default rule or override an unknown type', async () => {
    const defaults = (await api().get('/api/rules').set(bearer(admin.token))).body as any[];
    expect((await api().delete(`/api/rules/${defaults[0].id}`).set(bearer(admin.token))).status).toBe(404);
    expect((await api().put('/api/rules/override').set(bearer(admin.token)).send({ deviceType: 'Ghost', metric: 'cpu', severity: 'warning', threshold: 1 })).status).toBe(404);
  });

  it('edits a default limit', async () => {
    const before = find((await api().get('/api/rules').set(bearer(admin.token))).body, 'signal', 'critical');
    const res = await api().put(`/api/rules/${before.id}`).set(bearer(admin.token)).send({ threshold: -95 });
    expect(res.body.threshold).toBe(-95);
    await api().put(`/api/rules/${before.id}`).set(bearer(admin.token)).send({ threshold: before.threshold });
  });
});
