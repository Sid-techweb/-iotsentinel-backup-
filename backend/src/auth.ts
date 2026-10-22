import bcrypt from 'bcryptjs';
import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { col } from './mongo';
import { HttpError } from './util';

export type Role = 'admin' | 'viewer';
export interface AuthUser { id: string; email: string; name: string; role: Role }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: AuthUser } }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const signToken = (u: AuthUser) => jwt.sign({ sub: u.id }, config.jwtSecret, { expiresIn: '12h' });

/** Any signed-in user. Loads the user fresh so deleted accounts and role changes apply immediately. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'Sign in required');
    let sub: string;
    try {
      sub = (jwt.verify(token, config.jwtSecret) as { sub: string }).sub;
    } catch {
      throw new HttpError(401, 'Session expired - sign in again');
    }
    const row = await col('users').findOne({ _id: sub as any });
    if (!row) throw new HttpError(401, 'Account no longer exists');
    req.user = { id: row._id as unknown as string, email: row.email, name: row.name, role: row.role };
    next();
  } catch (e) {
    next(e);
  }
};

/** Viewers are read-only; only admins may change anything. */
export const adminWrites: RequestHandler = (req, _res, next) => {
  if (req.method !== 'GET' && req.user?.role !== 'admin') return next(new HttpError(403, 'Read-only account - ask an admin to make this change'));
  next();
};

/** Admin-only guard for reads as well as writes, for screens that expose secrets or user data. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'Administrator access required'));
  next();
};

