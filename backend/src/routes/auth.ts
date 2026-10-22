import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthUser, checkPassword, hashPassword, signToken } from '../auth';
import crypto from 'crypto';
import { col } from '../mongo';
import { redis } from '../redis';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError } from '../util';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email().max(120);
const password = z.string().min(8, 'Password must be at least 8 characters').max(100);

/** Brute-force guard: 10 failed attempts per IP per 15 minutes (counter lives in Redis). */
async function limitLogins(ip: string) {
  const key = `rl:login:${ip}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 900);
  if (n > 10) throw new HttpError(429, 'Too many attempts - try again in a few minutes');
  return key;
}

const session = (u: AuthUser) => ({ token: signToken(u), user: u });

/** The first account becomes the admin; later sign-ups are read-only viewers until promoted. */
authRouter.post('/register', asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), email, password }).parse(req.body);
  if (await col('users').findOne({ email: b.email }, { projection: { _id: 1 } })) throw new HttpError(409, 'An account with that email already exists');
  const first = (await col('users').estimatedDocumentCount()) === 0;
  const user: AuthUser = { id: crypto.randomUUID(), email: b.email, name: b.name, role: first ? 'admin' : 'viewer' };
  try {
    await col('users').insertOne({ _id: user.id as any, email: user.email, name: user.name, passwordHash: await hashPassword(b.password), role: user.role, createdAt: new Date() });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'An account with that email already exists'); // two sign-ups raced
    throw e;
  }
  audit({ userId: user.id, userEmail: user.email, ip: req.ip }, 'auth.register', 'user', user.id, { role: user.role });
  res.status(201).json(session(user));
}));

authRouter.post('/login', asyncH(async (req, res) => {
  const b = z.object({ email, password: z.string().min(1) }).parse(req.body);
  const key = await limitLogins(req.ip ?? 'unknown');
  const row = await col('users').findOne({ email: b.email });
  if (!row || !(await checkPassword(b.password, row.passwordHash))) {
    audit({ userEmail: b.email, ip: req.ip }, 'auth.login_failed', 'user', row?._id ?? null);
    throw new HttpError(401, 'Incorrect email or password');
  }
  await redis.del(key);
  const user: AuthUser = { id: row._id as unknown as string, email: row.email, name: row.name, role: row.role };
  audit({ userId: user.id, userEmail: user.email, ip: req.ip }, 'auth.login', 'user', user.id);
  res.json(session(user));
}));

authRouter.get('/me', authenticate, asyncH(async (req, res) => res.json(req.user)));

authRouter.patch('/me', authenticate, asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), email: email.optional() }).parse(req.body);
  if (b.email && (await col('users').findOne({ email: b.email, _id: { $ne: req.user!.id as any } }, { projection: { _id: 1 } }))) throw new HttpError(409, 'That email is already in use');
  const set: Record<string, string> = {};
  if (b.name) set.name = b.name;
  if (b.email) set.email = b.email;
  const updated = Object.keys(set).length
    ? await col('users').findOneAndUpdate({ _id: req.user!.id as any }, { $set: set }, { returnDocument: 'after' })
    : await col('users').findOne({ _id: req.user!.id as any });
  const user: AuthUser = { id: req.user!.id, email: updated!.email, name: updated!.name, role: updated!.role };
  audit(ctxOf(req), 'auth.profile_update', 'user', req.user!.id, { changed: Object.keys(b) });
  res.json(user);
}));

authRouter.post('/me/password', authenticate, asyncH(async (req, res) => {
  const b = z.object({ current: z.string().min(1), next: password }).parse(req.body);
  const row = await col('users').findOne({ _id: req.user!.id as any });
  if (!row || !(await checkPassword(b.current, row.passwordHash))) {
    audit(ctxOf(req), 'auth.password_change_failed', 'user', req.user!.id);
    throw new HttpError(400, 'Current password is incorrect');
  }
  await col('users').updateOne({ _id: req.user!.id as any }, { $set: { passwordHash: await hashPassword(b.next) } });
  audit(ctxOf(req), 'auth.password_change', 'user', req.user!.id);
  res.status(204).end();
}));
