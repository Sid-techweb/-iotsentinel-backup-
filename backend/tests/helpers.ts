import request from 'supertest';
import { createApp } from '../src/app';
import { migrate, pool } from '../src/db';
import { loadModel } from '../src/ml/model';
import { setProviderForTests } from '../src/services/ai/provider';
import { DeterministicTestProvider } from '../src/services/ai/testProvider';
import { ensureGlobalVersion } from '../src/services/retrain';
import { ensureReferenceData } from '../src/services/seed';

let appInstance: ReturnType<typeof createApp> | null = null;
let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Schema + reference data (machine types, default rules, firmware releases) on the empty test database. */
export async function bootstrap() {
  setProviderForTests(new DeterministicTestProvider()); // CI has no Ollama: use the labelled test double
  await migrate();
  await ensureReferenceData();
  loadModel();
  await ensureGlobalVersion();
  appInstance ??= createApp();
}

export const api = () => request(appInstance ?? (appInstance = createApp()));
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Create a user and return a session. Roles are set directly so tests do not depend on sign-up order. */
export async function newUser(role: 'admin' | 'viewer' = 'admin') {
  const email = `${role}-${uid()}@test.local`;
  const res = await api().post('/api/auth/register').send({ name: `Test ${role}`, email, password: 'test-password-1' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  await pool.query('UPDATE users SET role=$2 WHERE id=$1', [res.body.user.id, role]);
  return { token: res.body.token as string, user: { ...res.body.user, role } as { id: string; email: string; name: string; role: string }, email };
}

export async function newDevice(token: string, type = 'Smart Sensor', name = `dev-${uid()}`) {
  const res = await api().post('/api/devices').set(bearer(token)).send({ name, type, firmwareVersion: '1.0.0', location: 'Lab' });
  if (res.status !== 201) throw new Error(`device create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; apiKey: string; type: string };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` returns a truthy value (for work that happens just after the response). */
export async function eventually<T>(check: () => Promise<T | undefined | false> | T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition was not met in time');
    await sleep(60);
  }
}
