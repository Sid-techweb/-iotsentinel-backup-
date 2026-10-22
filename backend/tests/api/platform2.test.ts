import { beforeAll, describe, expect, it } from 'vitest';
import { migrate, pool } from '../../src/db';
import { col } from '../../src/mongo';
import { loadModel, scoreFeatures } from '../../src/ml/model';
import { ingest } from '../../src/services/ingest';
import { storeOverheatingHistory } from '../fixtures';
import { api, bearer, bootstrap, eventually, newDevice, newUser, sleep, uid } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });

describe('versioned migrations', () => {
  it('records each applied migration and applies nothing twice', async () => {
    const rows = (await pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows;
    expect(rows.map((r) => r.version)).toEqual(['001', '002', '003', '004']);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
    const again = await migrate();
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual([]);
  });

  it('creates the pgvector-backed knowledge base tables', async () => {
    const ext = (await pool.query("SELECT extname FROM pg_extension WHERE extname='vector'")).rows;
    expect(ext).toHaveLength(1);
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='kb_chunks'")).rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['embedding', 'content', 'tsv', 'document_id']));
  });
});

describe('device activation', () => {
  it('takes a device out of service without deleting it, and brings it back', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 99 }); // opens a critical alert
    const before = (await api().get('/api/dashboard/summary').set(bearer(admin.token))).body;

    const off = await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);

    // its open alerts are closed, telemetry is refused, and it is no longer counted
    const alerts = (await api().get(`/api/alerts?deviceId=${dev.id}&status=active`).set(bearer(admin.token))).body as any[];
    expect(alerts).toHaveLength(0);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 10 })).status).toBe(403);
    const after = (await api().get('/api/dashboard/summary').set(bearer(admin.token))).body;
    expect(after.totals.inactive).toBe(before.totals.inactive + 1);
    expect(after.totals.all).toBe(before.totals.all - 1);
    const fleet = (await api().get('/api/anomaly/predictions').set(bearer(admin.token))).body as any[];
    expect(fleet.some((d) => d.deviceId === dev.id)).toBe(false);
    expect((await api().get('/api/devices?active=false').set(bearer(admin.token))).body.some((d: any) => d.id === dev.id)).toBe(true);

    // the history is kept, and the change is in the maintenance log and the audit log
    const log = (await api().get(`/api/devices/${dev.id}/maintenance`).set(bearer(admin.token))).body as any[];
    expect(log[0]).toMatchObject({ kind: 'activation', summary: expect.stringContaining('deactivated') });
    expect(await col('audit_logs').countDocuments({ action: 'device.deactivate', entityId: dev.id })).toBe(1);

    const on = await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ active: true });
    expect(on.body.active).toBe(true);
    expect((await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 10 })).status).toBe(202);
  });

  it('edits name, location and IP and validates them; viewers cannot', async () => {
    const dev = await newDevice(admin.token);
    const other = await newDevice(admin.token);
    const ok = await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ location: 'Bay 7', ipAddress: '10.1.1.9' });
    expect(ok.body).toMatchObject({ location: 'Bay 7', ipAddress: '10.1.1.9' });
    expect((await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ ipAddress: null })).body.ipAddress).toBeNull();
    expect((await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ name: other.name })).status).toBe(409);
    expect((await api().patch(`/api/devices/${dev.id}`).set(bearer(admin.token)).send({ name: 'x' })).status).toBe(400);
    expect((await api().patch('/api/devices/00000000-0000-0000-0000-000000000000').set(bearer(admin.token)).send({ location: 'x' })).status).toBe(404);
    const viewer = await newUser('viewer');
    expect((await api().patch(`/api/devices/${dev.id}`).set(bearer(viewer.token)).send({ location: 'Nope' })).status).toBe(403);
  });

  it('gives every device a unique number people can search for', async () => {
    const a = await newDevice(admin.token);
    const b = await newDevice(admin.token);
    expect(a).toBeTruthy();
    const list = (await api().get('/api/devices').set(bearer(admin.token))).body as any[];
    const nos = list.map((d) => d.assetNo);
    expect(new Set(nos).size).toBe(nos.length);
    const mine = list.find((d) => d.id === b.id);
    expect(mine.assetNo).toBeGreaterThan(list.find((d) => d.id === a.id).assetNo);
    const found = (await api().get(`/api/devices?q=${mine.assetNo}`).set(bearer(admin.token))).body as any[];
    expect(found.some((d) => d.id === b.id)).toBe(true);
  });
});

describe('maintenance history', () => {
  it('records, lists and removes entries and attributes them to the user', async () => {
    const dev = await newDevice(admin.token, 'CNC Machine');
    const add = await api().post(`/api/devices/${dev.id}/maintenance`).set(bearer(admin.token))
      .send({ kind: 'inspection', summary: 'Spindle bearing inspected', details: 'Slight wear, re-check in 2 weeks', performedAt: '2026-01-05T09:00:00Z' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ kind: 'inspection', performedByName: 'Test admin' });
    await api().post(`/api/devices/${dev.id}/maintenance`).set(bearer(admin.token)).send({ kind: 'repair', summary: 'Replaced coolant pump' });

    const list = (await api().get(`/api/devices/${dev.id}/maintenance`).set(bearer(admin.token))).body as any[];
    expect(list.map((r) => r.kind)).toEqual(['repair', 'inspection']); // newest first
    expect((await api().delete(`/api/devices/${dev.id}/maintenance/${add.body.id}`).set(bearer(admin.token))).status).toBe(204);
    expect((await api().delete(`/api/devices/${dev.id}/maintenance/${add.body.id}`).set(bearer(admin.token))).status).toBe(404);
  });

  it('validates entries and keeps them admin-only', async () => {
    const dev = await newDevice(admin.token);
    const post = (b: object, token = admin.token) => api().post(`/api/devices/${dev.id}/maintenance`).set(bearer(token)).send(b);
    expect((await post({ kind: 'dance', summary: 'valid summary' })).status).toBe(400);
    expect((await post({ kind: 'note', summary: 'ab' })).status).toBe(400);
    expect((await post({ kind: 'note', summary: 'valid summary', performedAt: '2999-01-01T00:00:00Z' })).status).toBe(400);
    const viewer = await newUser('viewer');
    expect((await post({ kind: 'note', summary: 'valid summary' }, viewer.token)).status).toBe(403);
    expect((await api().get(`/api/devices/${dev.id}/maintenance`).set(bearer(viewer.token))).status).toBe(200);
  });

  it('adds a firmware entry automatically when a rollout completes', async () => {
    const dev = await newDevice(admin.token, 'Gateway');
    await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send();
    await api().post('/api/firmware/updates').set(bearer(admin.token)).send({ deviceId: dev.id });
    const entry = await eventually(async () => {
      const log = (await api().get(`/api/devices/${dev.id}/maintenance`).set(bearer(admin.token))).body as any[];
      return log.find((r) => r.kind === 'firmware');
    }, 20000).catch(() => undefined);
    // the simulated flasher fails about 8 % of rollouts on purpose; a failed rollout adds no entry
    const updates = (await api().get('/api/firmware/updates').set(bearer(admin.token))).body as any[];
    const mine = updates.find((u) => u.deviceId === dev.id);
    if (mine.status === 'completed') expect(entry?.summary).toContain('Firmware updated');
    else expect(entry).toBeUndefined();
  });
});

describe('history endpoints cover every signal (regression)', () => {
  it('returns vibration, pressure and motor current for a pump, not just the original five signals', async () => {
    const dev = await newDevice(admin.token, 'Pump Station');
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ vibration: 2.2, pressure: 5.1, current: 9.4 });
    const raw = (await api().get(`/api/devices/${dev.id}/telemetry`).set(bearer(admin.token))).body as any[];
    expect(raw[0]).toMatchObject({ vibration: 2.2, pressure: 5.1, current: 9.4 });
    const avg = (await api().get(`/api/devices/${dev.id}/readings?range=15m`).set(bearer(admin.token))).body;
    expect(avg.points[0].vibration).toBeCloseTo(2.2, 1);
    expect(avg.points[0].pressure).toBeCloseTo(5.1, 1);
    expect(avg.points[0].current).toBeCloseTo(9.4, 1);
  });
});

describe('prediction explanation and history', () => {
  async function rampingDevice() {
    const dev = await newDevice(admin.token, 'Smart Sensor'); // temperature warning limit: 70
    const start = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) await ingest(dev.id, { temperature: 40 + i * 1.3 }, new Date(start + i * 2000));
    return dev;
  }

  it('explains a prediction with exact feature contributions that add up to the model score', async () => {
    const dev = await rampingDevice();
    const res = await api().get(`/api/anomaly/explain/${dev.id}?metric=temperature`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/not the probability of equipment failure/i);
    const m = res.body.metrics[0];
    const e = m.explanation;
    expect(e.measure).toBe('threshold-breach');
    expect(e.threshold).toBe(70);
    expect(e.direction).toBe('above');
    expect(e.headroom).toBeGreaterThan(0);                 // not yet over the limit
    expect(e.slopePerMin).toBeGreaterThan(0);              // climbing
    expect(e.horizonSeconds).toBeCloseTo(e.horizonReadings * e.readingIntervalSeconds, 6);
    expect(e.features).toHaveLength(5);

    // linear model: bias + sum of contributions == logit, and sigmoid(logit) == the model's own probability
    const sum = e.features.reduce((a: number, f: any) => a + f.contribution, e.bias);
    expect(sum).toBeCloseTo(e.logit, 9);
    expect(e.modelProbability).toBeCloseTo(1 / (1 + Math.exp(-e.logit)), 9);
    expect(e.modelProbability).toBeCloseTo(scoreFeatures(loadModel(), e.features.map((f: any) => f.value)), 9);
    for (const f of e.features) expect(f.contribution).toBeCloseTo(f.weight * f.standardized, 9);

    expect(e.model).toMatchObject({ scope: 'global', source: 'synthetic' });
    expect(m.recentReadings.length).toBeGreaterThan(5);
    expect(m.recentReadings.at(-1).value).toBeCloseTo(40 + 19 * 1.3, 1);
  });

  it('reports an already-breached metric honestly instead of inventing a model score', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    const start = Date.now() - 60_000;
    for (let i = 0; i < 12; i++) await ingest(dev.id, { temperature: 66 + i }, new Date(start + i * 2000));
    const e = (await api().get(`/api/anomaly/explain/${dev.id}?metric=temperature`).set(bearer(admin.token))).body.metrics[0];
    expect(e.breached).toBe(true);
    expect(e.explanation.adjustmentNote).toMatch(/Already beyond the threshold/);
    expect(e.explanation.headroom).toBeLessThan(0);
  });

  it('stores snapshots with the model version and explanation, at most one per signal every 30 s', async () => {
    const dev = await rampingDevice();
    const rows = (await api().get(`/api/anomaly/history?deviceId=${dev.id}`).set(bearer(admin.token))).body as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2);              // the ramp lasts far less than 30 s of wall-clock time
    expect(rows[0]).toMatchObject({ metric: 'temperature', modelScope: 'global', modelSource: 'synthetic', deviceName: dev.name });
    expect(rows[0].modelVersion).toBeTruthy();
    expect(rows[0].probability).toBeGreaterThanOrEqual(0.3);
    expect(rows[0].explanation.measure).toBe('threshold-breach');
    expect((await api().get('/api/anomaly/history?deviceId=not-a-uuid').set(bearer(admin.token))).status).toBe(400);
  });

  it('keeps no history for a healthy, steady device', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor');
    const start = Date.now() - 60_000;
    for (let i = 0; i < 20; i++) await ingest(dev.id, { temperature: 40 + (i % 2) * 0.2 }, new Date(start + i * 2000));
    expect((await api().get(`/api/anomaly/history?deviceId=${dev.id}`).set(bearer(admin.token))).body).toHaveLength(0);
  });
});

describe('model versions', () => {
  it('lists the built-in global model as version 1', async () => {
    const versions = (await api().get('/api/anomaly/models/global/versions').set(bearer(admin.token))).body as any[];
    expect(versions[0]).toMatchObject({ scope: 'global', version: 1, source: 'synthetic', isActive: true, activated: true });
    expect(versions[0].evaluation.auc).toBeGreaterThan(0.9);
    expect((await api().post('/api/anomaly/models/global/versions/1/activate').set(bearer(admin.token))).status).toBe(400);
  });

  it('records every retrain as a version, uses a purge gap, and can roll back', async () => {
    const name = `Versioned ${uid()}`;
    await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['temperature'] });
    const dev = await newDevice(admin.token, name);
    await storeOverheatingHistory(dev.id);

    const first = (await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: name })).body;
    expect(first.version).toBe(1);
    expect(first.activated).toBe(true);
    expect(first.samples.purged).toBeGreaterThan(0);        // windows dropped between train and test to prevent leakage

    const second = (await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: name })).body;
    expect(second.version).toBe(2);

    const versions = (await api().get(`/api/anomaly/models/${encodeURIComponent(name)}/versions`).set(bearer(admin.token))).body as any[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.filter((v) => v.isActive)).toHaveLength(1);       // exactly one active version
    expect(versions[0].trainedBy).toBe(admin.email);
    expect(versions[0].previousEvaluation.auc).toBeGreaterThan(0);

    if (second.activated) {
      const back = await api().post(`/api/anomaly/models/${encodeURIComponent(name)}/versions/1/activate`).set(bearer(admin.token));
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ version: 1, isActive: true });
      const card = (await api().get(`/api/anomaly/model?scope=${encodeURIComponent(name)}`).set(bearer(admin.token))).body;
      expect(card.version).toBe('v1');
    }
    expect((await api().post(`/api/anomaly/models/${encodeURIComponent(name)}/versions/99/activate`).set(bearer(admin.token))).status).toBe(404);
    expect(await col('audit_logs').countDocuments({ action: 'model.retrain', entityId: name })).toBeGreaterThanOrEqual(2);
  });

  it('refuses to activate a version that failed the validation gate', async () => {
    const name = `Rejected ${uid()}`;
    await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['temperature'] });
    await col('model_versions').insertOne({
      _id: Date.now() as any, scope: name, version: 1, source: 'telemetry', samples: 100, evaluation: { auc: 0.55 }, activated: false, isActive: false, reason: 'rejected in test', model: {}, trainedAt: new Date(),
    });
    const res = await api().post(`/api/anomaly/models/${encodeURIComponent(name)}/versions/1/activate`).set(bearer(admin.token));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/validation gate/);
  });
});

describe('audit log', () => {
  it('records sign-ins, failures and administrative actions - without secrets', async () => {
    const { email } = await newUser('viewer');
    await api().post('/api/auth/login').send({ email, password: 'wrong-password-123' });
    await api().post('/api/auth/login').send({ email, password: 'test-password-1' });
    const dev = await newDevice(admin.token);
    await api().post(`/api/devices/${dev.id}/key`).set(bearer(admin.token));
    await sleep(150); // audit writes are fire-and-forget

    const rows = (await api().get('/api/audit?limit=200').set(bearer(admin.token))).body as any[];
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login', 'auth.register', 'device.create', 'device.key_rotate']));
    const failed = rows.find((r) => r.action === 'auth.login_failed' && r.userEmail === email);
    expect(failed.userId).toBeNull();
    expect(failed.ip).toBeTruthy();

    // nothing sensitive is ever written
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('test-password-1');
    expect(dump).not.toContain('wrong-password-123');
    expect(dump).not.toContain(dev.apiKey);
    expect(dump).not.toMatch(/password_hash|passwordHash/);
  });

  it('is admin-only, filterable, paginated and exportable', async () => {
    const viewer = await newUser('viewer');
    expect((await api().get('/api/audit').set(bearer(viewer.token))).status).toBe(403);
    expect((await api().get('/api/audit/export.csv').set(bearer(viewer.token))).status).toBe(403);

    const logins = (await api().get('/api/audit?action=auth.login').set(bearer(admin.token))).body as any[];
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((r) => r.action.startsWith('auth.login'))).toBe(true);

    const page1 = (await api().get('/api/audit?limit=3').set(bearer(admin.token))).body as any[];
    const page2 = (await api().get(`/api/audit?limit=3&before=${page1.at(-1).id}`).set(bearer(admin.token))).body as any[];
    expect(page1).toHaveLength(3);
    expect(page2[0].id).toBeLessThan(page1.at(-1).id);

    const csv = await api().get('/api/audit/export.csv?limit=10').set(bearer(admin.token));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toBe('ID,Time,User,Action,Entity,Entity ID,IP,Details');
    expect((await api().get('/api/audit?limit=99999').set(bearer(admin.token))).status).toBe(400);
  });

  it('logs role changes with before and after', async () => {
    const target = await newUser('viewer');
    await api().patch(`/api/users/${target.user.id}`).set(bearer(admin.token)).send({ role: 'admin' });
    await sleep(150);
    const row = ((await api().get('/api/audit?action=user.role_change').set(bearer(admin.token))).body as any[]).find((r) => r.entityId === target.user.id);
    expect(row.details).toEqual({ from: 'viewer', to: 'admin' });
  });
});

describe('dashboard filters', () => {
  it('limits the overview to one machine type, and reports an empty type as zeros', async () => {
    await newDevice(admin.token, 'Pump Station');
    const all = (await api().get('/api/dashboard/summary').set(bearer(admin.token))).body;
    const pumps = (await api().get('/api/dashboard/summary?type=Pump%20Station').set(bearer(admin.token))).body;
    expect(pumps.type).toBe('Pump Station');
    expect(pumps.totals.all).toBeGreaterThan(0);
    expect(pumps.totals.all).toBeLessThan(all.totals.all);

    const none = (await api().get('/api/dashboard/summary?type=Nothing%20Here').set(bearer(admin.token))).body;
    expect(none.totals).toEqual({ online: 0, degraded: 0, offline: 0, all: 0, inactive: 0 });
    expect(none.alerts).toEqual([]);
    expect(none.activity).toEqual([]);
    expect(none.firmwareOutdated).toBe(0);
  });
});
