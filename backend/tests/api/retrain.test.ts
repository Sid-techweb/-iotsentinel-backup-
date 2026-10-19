import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/db';
import { loadModel, modelFor } from '../../src/ml/model';
import { storeOverheatingHistory } from '../fixtures';
import { api, bearer, bootstrap, newDevice, newUser, uid } from '../helpers';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });

describe('retraining a machine type from its own telemetry', () => {
  it('learns from stored telemetry, activates the better model and uses it for that type only', async () => {
    const name = `Press ${uid()}`;
    await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['temperature'] });
    const dev = await newDevice(admin.token, name);
    await storeOverheatingHistory(dev.id);

    expect(modelFor(name)).toBe(loadModel()); // no model of its own yet
    const res = await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: name });
    expect(res.status).toBe(200);
    expect(res.body.samples.positives).toBeGreaterThan(30);
    expect(res.body.evaluation.auc).toBeGreaterThan(0.85);
    expect(res.body.activated).toBe(true);
    expect(res.body.reason).toMatch(/Activated/);

    expect(modelFor(name).scope).toBe(name);
    expect(modelFor(name).source).toBe('telemetry');
    expect(modelFor('Gateway')).toBe(loadModel()); // other types are untouched
    expect((await pool.query('SELECT source, samples FROM models WHERE scope=$1', [name])).rows[0].source).toBe('telemetry');

    const card = (await api().get(`/api/anomaly/model?scope=${encodeURIComponent(name)}`).set(bearer(admin.token))).body;
    expect(card).toMatchObject({ scope: name, source: 'telemetry', fallback: false });
    const scopes = (await api().get('/api/anomaly/models').set(bearer(admin.token))).body as any[];
    expect(scopes.find((s) => s.scope === name)).toMatchObject({ own: true, source: 'telemetry' });

    // dropping it returns the type to the global model
    expect((await api().delete(`/api/anomaly/models/${encodeURIComponent(name)}`).set(bearer(admin.token))).status).toBe(204);
    expect(modelFor(name)).toBe(loadModel());
    expect((await api().get(`/api/anomaly/model?scope=${encodeURIComponent(name)}`).set(bearer(admin.token))).body.fallback).toBe(true);
  });

  it('refuses to train when there is not enough labelled telemetry, and says why', async () => {
    const name = `Quiet ${uid()}`;
    await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['temperature'] });
    const dev = await newDevice(admin.token, name);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ temperature: 40 });
    const res = await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: name });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Not enough labelled telemetry/);
    expect(modelFor(name)).toBe(loadModel());
  });

  it('rejects unknown types, empty types and non-admins', async () => {
    expect((await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: 'Ghost' })).status).toBe(404);
    const name = `Empty ${uid()}`;
    await api().post('/api/device-types').set(bearer(admin.token)).send({ name, metrics: ['cpu'] });
    expect((await api().post('/api/anomaly/retrain').set(bearer(admin.token)).send({ deviceType: name })).status).toBe(422);
    const viewer = await newUser('viewer');
    expect((await api().post('/api/anomaly/retrain').set(bearer(viewer.token)).send({ deviceType: name })).status).toBe(403);
    expect((await api().delete('/api/anomaly/models/global').set(bearer(admin.token))).status).toBe(400);
  });
});
