import express from 'express';
import { AddressInfo } from 'net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { rateLimit } from '../../src/middleware/rateLimit';
import { publish, startEventBus, stopEventBus } from '../../src/services/events';
import { api, bearer, bootstrap, eventually, newDevice, newUser, sleep, uid } from '../helpers';
import { errorHandlerFor } from './errorHandler';

let admin: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => { await bootstrap(); admin = await newUser('admin'); });
afterAll(async () => { await stopEventBus(); });

describe('user management', () => {
  it('lists users and changes roles', async () => {
    const target = await newUser('viewer');
    const list = (await api().get('/api/users').set(bearer(admin.token))).body as any[];
    expect(list.find((u) => u.id === target.user.id)).toMatchObject({ role: 'viewer' });
    expect(list[0]).not.toHaveProperty('passwordHash');

    const promoted = await api().patch(`/api/users/${target.user.id}`).set(bearer(admin.token)).send({ role: 'admin' });
    expect(promoted.body.role).toBe('admin');
    // the change applies to the user's existing session straight away
    expect((await api().post('/api/simulator/pause').set(bearer(target.token))).status).toBe(200);
    await api().post('/api/simulator/resume').set(bearer(target.token));
  });

  it('never lets the last administrator be removed', async () => {
    await pool.query("DELETE FROM users WHERE role='admin'"); // start from a clean slate for this scenario
    const only = await newUser('admin');
    expect((await api().patch(`/api/users/${only.user.id}`).set(bearer(only.token)).send({ role: 'viewer' })).status).toBe(409);
    expect((await api().delete(`/api/users/${only.user.id}`).set(bearer(only.token))).status).toBe(409); // also: not yourself
    const second = await newUser('admin');
    expect((await api().patch(`/api/users/${second.user.id}`).set(bearer(only.token)).send({ role: 'viewer' })).status).toBe(200);
    expect((await api().delete(`/api/users/${second.user.id}`).set(bearer(only.token))).status).toBe(204);
    admin = only;
  });

  it('answers 404 for users that do not exist', async () => {
    expect((await api().patch('/api/users/00000000-0000-0000-0000-000000000000').set(bearer(admin.token)).send({ role: 'viewer' })).status).toBe(404);
    expect((await api().delete('/api/users/00000000-0000-0000-0000-000000000000').set(bearer(admin.token))).status).toBe(404);
  });
});

describe('security incidents', () => {
  it('records, filters, updates and exports incidents', async () => {
    const dev = await newDevice(admin.token);
    const created = await api().post('/api/incidents').set(bearer(admin.token)).send({ deviceId: dev.id, category: 'Configuration tampering', severity: 'high', description: 'Hash changed, no change ticket' });
    expect(created.status).toBe(201);

    const open = (await api().get('/api/incidents?status=open&severity=high').set(bearer(admin.token))).body as any[];
    expect(open.some((i) => i.id === created.body.id && i.deviceName === dev.name)).toBe(true);

    const updated = await api().patch(`/api/incidents/${created.body.id}`).set(bearer(admin.token)).send({ status: 'investigating' });
    expect(updated.body.status).toBe('investigating');
    expect((await api().patch(`/api/incidents/${created.body.id}`).set(bearer(admin.token)).send({ status: 'bogus' })).status).toBe(400);

    const csv = await api().get('/api/incidents/export.csv?status=investigating').set(bearer(admin.token));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Hash changed, no change ticket');

    const summary = (await api().get('/api/incidents/summary').set(bearer(admin.token))).body;
    expect(summary.byCategory.some((c: any) => c.category === 'Configuration tampering')).toBe(true);
  });

  it('neutralises spreadsheet formulas in exported text', async () => {
    await api().post('/api/incidents').set(bearer(admin.token)).send({ category: 'Unauthorized access', severity: 'low', description: '=HYPERLINK("http://evil.example","click")' });
    const csv = await api().get('/api/incidents/export.csv').set(bearer(admin.token));
    expect(csv.text).toContain(`'=HYPERLINK`);
    expect(csv.text).not.toMatch(/(^|,|\r\n)"?=HYPERLINK/);
  });

  it('rejects malformed incidents', async () => {
    const post = (b: object) => api().post('/api/incidents').set(bearer(admin.token)).send(b);
    expect((await post({ category: 'x', severity: 'high', description: 'valid text' })).status).toBe(400);
    expect((await post({ category: 'Valid category', severity: 'severe', description: 'valid text' })).status).toBe(400);
    expect((await post({ category: 'Valid category', severity: 'high', description: 'ab' })).status).toBe(400);
  });
});

describe('firmware', () => {
  it('reports compliance and rolls an update out to completion', async () => {
    const dev = await newDevice(admin.token, 'Smart Sensor'); // registered on 1.0.0; latest release is newer
    await api().post('/api/telemetry/heartbeat').set('x-api-key', dev.apiKey).send();

    const compliance = (await api().get('/api/firmware/compliance').set(bearer(admin.token))).body as any[];
    const row = compliance.find((c) => c.id === dev.id);
    expect(row).toMatchObject({ outdated: true, current: '1.0.0' });
    expect(row.missedSecurityReleases).toBeGreaterThan(0);

    const start = await api().post('/api/firmware/updates').set(bearer(admin.token)).send({ deviceId: dev.id });
    expect(start.status).toBe(201);
    expect((await api().post('/api/firmware/updates').set(bearer(admin.token)).send({ deviceId: dev.id })).status).toBe(409); // already running

    const done = await eventually(async () => {
      const updates = (await api().get('/api/firmware/updates').set(bearer(admin.token))).body as any[];
      const mine = updates.find((u) => u.deviceId === dev.id);
      return mine && mine.status !== 'in_progress' ? mine : undefined;
    }, 15000);
    expect(['completed', 'failed']).toContain(done.status); // the simulator fails ~8 % of rollouts on purpose
    if (done.status === 'completed') {
      expect((await api().get(`/api/devices/${dev.id}`).set(bearer(admin.token))).body.firmwareVersion).toBe(done.toVersion);
    }
  });

  it('will not update an offline device or to an unknown version', async () => {
    const offline = await newDevice(admin.token, 'Gateway'); // never reported: offline
    expect((await api().post('/api/firmware/updates').set(bearer(admin.token)).send({ deviceId: offline.id })).status).toBe(409);
    const online = await newDevice(admin.token, 'Gateway');
    await api().post('/api/telemetry/heartbeat').set('x-api-key', online.apiKey).send();
    expect((await api().post('/api/firmware/updates').set(bearer(admin.token)).send({ deviceId: online.id, toVersion: '9.9.9' })).status).toBe(404);
  });
});

describe('dashboard summary', () => {
  it('aggregates fleet status, alerts and firmware gaps', async () => {
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 99 });
    const s = (await api().get('/api/dashboard/summary').set(bearer(admin.token))).body;
    expect(s.totals.all).toBeGreaterThan(0);
    expect(s.totals.online + s.totals.degraded + s.totals.offline).toBe(s.totals.all);
    expect(Array.isArray(s.activity)).toBe(true);
    expect(typeof s.firmwareOutdated).toBe('number');
  });
});

describe('real-time push (server-sent events)', () => {
  it('streams events published anywhere in the backend to signed-in browsers', async () => {
    startEventBus();
    const server = createApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/events`, { signal: AbortSignal.timeout(2000) }).catch(() => ({ status: 0 }))).status).not.toBe(200);

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Authorization: `Bearer ${admin.token}` }, signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        const end = Date.now() + 4000;
        while (!text.includes(needle) && Date.now() < end) {
          const chunk = await Promise.race([reader.read(), sleep(300).then(() => null)]);
          if (chunk && !chunk.done) text += decoder.decode(chunk.value);
        }
        return text.includes(needle);
      };
      expect(await readUntil('event: hello')).toBe(true);
      await sleep(150); // let the subscription settle
      publish('alert', { id: 42 });
      expect(await readUntil('event: alert')).toBe(true);
      expect(text).toContain('"id":42');
    } finally {
      controller.abort();
      await stopEventBus();
      server.close();
    }
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After once a client exceeds its allowance', async () => {
    config.rateLimit = true;
    try {
      const app = express();
      const who = `test-${uid()}`;
      app.get('/limited', rateLimit({ name: 'test', max: 3, by: () => who }), (_req, res) => res.json({ ok: true }));
      app.use(errorHandlerFor());
      for (let i = 0; i < 3; i++) expect((await request(app).get('/limited')).status).toBe(200);
      const blocked = await request(app).get('/limited');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.headers['ratelimit-remaining']).toBe('0');
    } finally {
      config.rateLimit = false;
    }
  });

  it('counts each caller separately', async () => {
    config.rateLimit = true;
    try {
      const app = express();
      app.get('/limited', rateLimit({ name: 'test2', max: 1, by: (req) => String(req.header('x-who')) }), (_req, res) => res.json({ ok: true }));
      app.use(errorHandlerFor());
      const a = `a-${uid()}`, b = `b-${uid()}`;
      expect((await request(app).get('/limited').set('x-who', a)).status).toBe(200);
      expect((await request(app).get('/limited').set('x-who', a)).status).toBe(429);
      expect((await request(app).get('/limited').set('x-who', b)).status).toBe(200);
    } finally {
      config.rateLimit = false;
    }
  });
});
