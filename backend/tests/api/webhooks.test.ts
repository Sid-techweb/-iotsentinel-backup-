import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { createIncident } from '../../src/services/incidents';
import { sign } from '../../src/services/webhooks';
import { api, bearer, bootstrap, eventually, newDevice, newUser } from '../helpers';

interface Received { headers: http.IncomingHttpHeaders; raw: string; body: any }
const received: Received[] = [];
let receiver: http.Server;
let url: string;
let admin: Awaited<ReturnType<typeof newUser>>;
let respondWith = 200;

beforeAll(async () => {
  await bootstrap();
  admin = await newUser('admin');
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw, body: JSON.parse(raw || '{}') });
      res.writeHead(respondWith).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((r) => receiver.close(() => r())));

async function createHook(events: string[]) {
  const res = await api().post('/api/webhooks').set(bearer(admin.token)).send({ name: 'Test receiver', url, events });
  expect(res.status).toBe(201);
  return res.body as { id: number; secret: string };
}

describe('webhook notifications', () => {
  it('shows the signing secret once and never lists it again', async () => {
    const hook = await createHook(['alert.critical']);
    expect(hook.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const list = (await api().get('/api/webhooks').set(bearer(admin.token))).body;
    const found = list.webhooks.find((w: any) => w.id === hook.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('secret');
    expect(list.events).toContain('alert.predictive');
  });

  it('delivers a signed test event the receiver can verify', async () => {
    const hook = await createHook(['alert.critical']);
    received.length = 0;
    const res = await api().post(`/api/webhooks/${hook.id}/test`).set(bearer(admin.token));
    expect(res.body).toMatchObject({ ok: true, statusCode: 200 });
    const got = received.at(-1)!;
    expect(got.headers['x-sentinel-event']).toBe('test.ping');
    expect(got.headers['x-sentinel-signature']).toBe(sign(hook.secret, got.raw));
    // an independent check of the signature scheme documented for receivers
    expect(got.headers['x-sentinel-signature']).toBe('sha256=' + crypto.createHmac('sha256', hook.secret).update(got.raw).digest('hex'));
    expect(got.body.text).toContain('test');
  });

  it('notifies on a critical alert, and only for the events it subscribed to', async () => {
    const critical = await createHook(['alert.critical']);
    const incidents = await createHook(['incident.created']);
    received.length = 0;
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ cpu: 99 });

    const got = await eventually(() => received.find((r) => r.body.event === 'alert.critical' && r.body.data.device === dev.name));
    expect(got.body.data).toMatchObject({ severity: 'critical', metric: 'cpu', device: dev.name });
    expect(got.headers['x-sentinel-signature']).toMatch(/^sha256=/);
    expect(received.some((r) => r.body.event === 'incident.created' && r.body.data.device === dev.name)).toBe(false);
    void critical; void incidents;
  });

  it('notifies on high-severity incidents but not low ones', async () => {
    await createHook(['incident.created']);
    received.length = 0;
    const dev = await newDevice(admin.token);
    await createIncident({ deviceId: dev.id, category: 'Brute-force login', severity: 'low', description: 'minor noise' });
    await createIncident({ deviceId: dev.id, category: 'Unauthorized access', severity: 'critical', description: 'root login from unknown IP' });
    const got = await eventually(() => received.find((r) => r.body.event === 'incident.created' && r.body.data.device === dev.name));
    expect(got.body.data.severity).toBe('critical');
    expect(received.filter((r) => r.body.data?.device === dev.name && r.body.data?.severity === 'low')).toHaveLength(0);
  });

  it('records failures in the delivery log', async () => {
    const hook = await createHook(['alert.critical']);
    respondWith = 500;
    const res = await api().post(`/api/webhooks/${hook.id}/test`).set(bearer(admin.token));
    respondWith = 200;
    expect(res.body).toMatchObject({ ok: false, statusCode: 500 });
    const log = (await api().get(`/api/webhooks/${hook.id}/deliveries`).set(bearer(admin.token))).body as any[];
    expect(log[0]).toMatchObject({ ok: false, statusCode: 500, event: 'test.ping' });
  });

  it('does not send to a disabled webhook, and can delete one', async () => {
    const hook = await createHook(['alert.critical']);
    await api().put(`/api/webhooks/${hook.id}`).set(bearer(admin.token)).send({ enabled: false });
    received.length = 0;
    const dev = await newDevice(admin.token);
    await api().post('/api/telemetry').set('x-api-key', dev.apiKey).send({ memory: 99 });
    await new Promise((r) => setTimeout(r, 400));
    const own = (await api().get(`/api/webhooks/${hook.id}/deliveries`).set(bearer(admin.token))).body as any[];
    expect(own).toHaveLength(0);
    expect((await api().delete(`/api/webhooks/${hook.id}`).set(bearer(admin.token))).status).toBe(204);
    expect((await api().delete(`/api/webhooks/${hook.id}`).set(bearer(admin.token))).status).toBe(404);
  });
});

describe('webhook safety', () => {
  it('refuses private and local addresses unless explicitly allowed', async () => {
    config.allowPrivateWebhooks = false;
    try {
      for (const bad of ['http://127.0.0.1:9/x', 'http://10.0.0.5/x', 'http://192.168.1.10/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x']) {
        const res = await api().post('/api/webhooks').set(bearer(admin.token)).send({ name: 'Bad target', url: bad, events: ['alert.critical'] });
        expect(res.status, bad).toBe(400);
        expect(res.body.error).toMatch(/private or local/);
      }
    } finally {
      config.allowPrivateWebhooks = true;
    }
  });

  it('rejects malformed URLs, other schemes and empty event lists', async () => {
    const post = (b: object) => api().post('/api/webhooks').set(bearer(admin.token)).send(b);
    expect((await post({ name: 'x1', url: 'not a url', events: ['alert.critical'] })).status).toBe(400);
    expect((await post({ name: 'x2', url: 'file:///etc/passwd', events: ['alert.critical'] })).status).toBe(400);
    expect((await post({ name: 'x3', url, events: [] })).status).toBe(400);
    expect((await post({ name: 'x4', url, events: ['nonsense'] })).status).toBe(400);
  });

  it('re-checks the address when sending, so a webhook cannot be pointed inward later', async () => {
    const hook = await createHook(['alert.critical']);
    config.allowPrivateWebhooks = false;
    try {
      const res = await api().post(`/api/webhooks/${hook.id}/test`).set(bearer(admin.token));
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/private or local/);
    } finally {
      config.allowPrivateWebhooks = true;
    }
  });
});
