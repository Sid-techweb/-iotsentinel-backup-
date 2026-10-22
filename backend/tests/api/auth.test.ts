import { beforeAll, describe, expect, it } from 'vitest';
import { col } from '../../src/mongo';
import { api, bearer, bootstrap, newUser, uid } from '../helpers';

beforeAll(bootstrap);

describe('authentication', () => {
  it('registers, logs in and returns the profile', async () => {
    const email = `a-${uid()}@test.local`;
    const reg = await api().post('/api/auth/register').send({ name: 'Ada Lovelace', email, password: 'correct-horse-1' });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeTruthy();
    expect(reg.body.user).not.toHaveProperty('passwordHash');

    const login = await api().post('/api/auth/login').send({ email: email.toUpperCase(), password: 'correct-horse-1' });
    expect(login.status).toBe(200);

    const me = await api().get('/api/auth/me').set(bearer(login.body.token));
    expect(me.body.email).toBe(email);
  });

  it('rejects duplicate emails, short passwords and bad credentials', async () => {
    const { email } = await newUser('viewer');
    expect((await api().post('/api/auth/register').send({ name: 'Dup', email, password: 'another-pass-1' })).status).toBe(409);
    expect((await api().post('/api/auth/register').send({ name: 'Weak', email: `w-${uid()}@test.local`, password: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/login').send({ email, password: 'wrong-password' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'whatever-1' })).status).toBe(401);
  });

  it('never stores or returns the plain password', async () => {
    const { email } = await newUser('viewer');
    const row = (await col('users').findOne({ email }))!;
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(row.passwordHash).not.toContain('test-password-1');
  });

  it('changes the password only when the current one is right', async () => {
    const { token, email } = await newUser('viewer');
    const bad = await api().post('/api/auth/me/password').set(bearer(token)).send({ current: 'nope-nope-1', next: 'brand-new-pass-1' });
    expect(bad.status).toBe(400);
    const ok = await api().post('/api/auth/me/password').set(bearer(token)).send({ current: 'test-password-1', next: 'brand-new-pass-1' });
    expect(ok.status).toBe(204);
    expect((await api().post('/api/auth/login').send({ email, password: 'test-password-1' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email, password: 'brand-new-pass-1' })).status).toBe(200);
  });

  it('updates profile details and refuses an email that is taken', async () => {
    const a = await newUser('viewer');
    const b = await newUser('viewer');
    expect((await api().patch('/api/auth/me').set(bearer(a.token)).send({ name: 'Renamed Person' })).body.name).toBe('Renamed Person');
    expect((await api().patch('/api/auth/me').set(bearer(a.token)).send({ email: b.email })).status).toBe(409);
  });
});

describe('access control', () => {
  it('requires a valid token for the API', async () => {
    expect((await api().get('/api/devices')).status).toBe(401);
    expect((await api().get('/api/devices').set({ Authorization: 'Bearer not-a-token' })).status).toBe(401);
    expect((await api().get('/api/devices').set({ Authorization: 'Basic abc' })).status).toBe(401);
  });

  it('leaves health and device ingest reachable without a user session', async () => {
    expect((await api().get('/api/health')).status).toBe(200);
    expect((await api().post('/api/telemetry').send({})).status).toBe(401); // reaches the device-key check, not the user check
  });

  it('lets viewers read but not change anything', async () => {
    const viewer = await newUser('viewer');
    expect((await api().get('/api/devices').set(bearer(viewer.token))).status).toBe(200);
    const write = await api().post('/api/devices').set(bearer(viewer.token)).send({ name: 'nope', type: 'Gateway', firmwareVersion: '1.0.0' });
    expect(write.status).toBe(403);
    expect((await api().post('/api/simulator/pause').set(bearer(viewer.token))).status).toBe(403);
  });

  it('keeps user management and webhooks admin-only, even for reading', async () => {
    const viewer = await newUser('viewer');
    expect((await api().get('/api/users').set(bearer(viewer.token))).status).toBe(403);
    expect((await api().get('/api/webhooks').set(bearer(viewer.token))).status).toBe(403);
    const admin = await newUser('admin');
    expect((await api().get('/api/users').set(bearer(admin.token))).status).toBe(200);
  });

  it('answers malformed requests with clear 4xx errors', async () => {
    const { token } = await newUser('admin');
    const badJson = await api().post('/api/devices').set(bearer(token)).set('Content-Type', 'application/json').send('{not json');
    expect(badJson.status).toBe(400);
    expect((await api().get('/api/devices/not-a-uuid').set(bearer(token))).status).toBe(404);
    expect((await api().get('/api/nothing-here').set(bearer(token))).status).toBe(404);
  });
});
