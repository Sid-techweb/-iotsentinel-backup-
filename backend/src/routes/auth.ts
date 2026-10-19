import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthUser, checkPassword, hashPassword, signToken } from '../auth';
import { q1 } from '../db';
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
  if (await q1('SELECT 1 FROM users WHERE email=$1', [b.email])) throw new HttpError(409, 'An account with that email already exists');
  const first = ((await q1<{ n: number }>('SELECT count(*)::int AS n FROM users'))!).n === 0;
  const user = (await q1<AuthUser>(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
    [b.email, b.name, await hashPassword(b.password), first ? 'admin' : 'viewer'],
  ))!;
  audit({ userId: user.id, userEmail: user.email, ip: req.ip }, 'auth.register', 'user', user.id, { role: user.role });
  res.status(201).json(session(user));
}));

authRouter.post('/login', asyncH(async (req, res) => {
  const b = z.object({ email, password: z.string().min(1) }).parse(req.body);
  const key = await limitLogins(req.ip ?? 'unknown');
  const row = await q1<AuthUser & { passwordHash: string }>('SELECT id, email, name, role, password_hash FROM users WHERE email=$1', [b.email]);
  if (!row || !(await checkPassword(b.password, row.passwordHash))) {
    audit({ userEmail: b.email, ip: req.ip }, 'auth.login_failed', 'user', row?.id ?? null);
    throw new HttpError(401, 'Incorrect email or password');
  }
  await redis.del(key);
  const { passwordHash: _omit, ...user } = row;
  audit({ userId: user.id, userEmail: user.email, ip: req.ip }, 'auth.login', 'user', user.id);
  res.json(session(user));
}));

authRouter.get('/me', authenticate, asyncH(async (req, res) => res.json(req.user)));

authRouter.patch('/me', authenticate, asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), email: email.optional() }).parse(req.body);
  if (b.email && (await q1('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [b.email, req.user!.id]))) throw new HttpError(409, 'That email is already in use');
  const user = await q1<AuthUser>(
    'UPDATE users SET name=COALESCE($2,name), email=COALESCE($3,email) WHERE id=$1 RETURNING id, email, name, role',
    [req.user!.id, b.name ?? null, b.email ?? null],
  );
  audit(ctxOf(req), 'auth.profile_update', 'user', req.user!.id, { changed: Object.keys(b) });
  res.json(user);
}));

authRouter.post('/me/password', authenticate, asyncH(async (req, res) => {
  const b = z.object({ current: z.string().min(1), next: password }).parse(req.body);
  const row = await q1<{ passwordHash: string }>('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
  if (!row || !(await checkPassword(b.current, row.passwordHash))) {
    audit(ctxOf(req), 'auth.password_change_failed', 'user', req.user!.id);
    throw new HttpError(400, 'Current password is incorrect');
  }
  await q1('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user!.id, await hashPassword(b.next)]);
  audit(ctxOf(req), 'auth.password_change', 'user', req.user!.id);
  res.status(204).end();
}));
