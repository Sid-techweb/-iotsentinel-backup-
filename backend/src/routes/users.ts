import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { q, q1 } from '../db';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError } from '../util';

export const usersRouter = Router();
usersRouter.use(requireAdmin);

const adminCount = async () => ((await q1<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role='admin'"))!).n;

usersRouter.get('/', asyncH(async (_req, res) => {
  res.json(await q('SELECT id, email, name, role, created_at FROM users ORDER BY created_at'));
}));

usersRouter.patch('/:id', asyncH(async (req, res) => {
  const b = z.object({ role: z.enum(['admin', 'viewer']) }).parse(req.body);
  const target = await q1<{ role: string }>('SELECT role FROM users WHERE id=$1', [req.params.id]).catch(() => undefined);
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role === 'admin' && b.role !== 'admin' && (await adminCount()) <= 1) throw new HttpError(409, 'There must always be at least one administrator');
  const row = await q1('UPDATE users SET role=$2 WHERE id=$1 RETURNING id, email, name, role, created_at', [req.params.id, b.role]);
  publish('user');
  audit(ctxOf(req), 'user.role_change', 'user', req.params.id, { from: target.role, to: b.role });
  res.json(row);
}));

usersRouter.delete('/:id', asyncH(async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(409, 'You cannot delete your own account here');
  const target = await q1<{ role: string }>('SELECT role FROM users WHERE id=$1', [req.params.id]).catch(() => undefined);
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role === 'admin' && (await adminCount()) <= 1) throw new HttpError(409, 'There must always be at least one administrator');
  await q('DELETE FROM users WHERE id=$1', [req.params.id]);
  audit(ctxOf(req), 'user.delete', 'user', req.params.id, { role: target.role });
  res.status(204).end();
}));
