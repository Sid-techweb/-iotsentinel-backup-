import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { col } from '../mongo';
import { publish } from '../services/events';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError } from '../util';

export const usersRouter = Router();
usersRouter.use(requireAdmin);

const adminCount = () => col('users').countDocuments({ role: 'admin' });
const publicUser = (u: any) => ({ id: u._id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt });

usersRouter.get('/', asyncH(async (_req, res) => {
  res.json((await col('users').find({}).sort({ createdAt: 1 }).toArray()).map(publicUser));
}));

usersRouter.patch('/:id', asyncH(async (req, res) => {
  const b = z.object({ role: z.enum(['admin', 'viewer']) }).parse(req.body);
  const target = await col('users').findOne({ _id: String(req.params.id) as any });
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role === 'admin' && b.role !== 'admin' && (await adminCount()) <= 1) throw new HttpError(409, 'There must always be at least one administrator');
  const row = publicUser((await col('users').findOneAndUpdate({ _id: String(req.params.id) as any }, { $set: { role: b.role } }, { returnDocument: 'after' }))!);
  publish('user');
  audit(ctxOf(req), 'user.role_change', 'user', req.params.id, { from: target.role, to: b.role });
  res.json(row);
}));

usersRouter.delete('/:id', asyncH(async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(409, 'You cannot delete your own account here');
  const target = await col('users').findOne({ _id: String(req.params.id) as any });
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role === 'admin' && (await adminCount()) <= 1) throw new HttpError(409, 'There must always be at least one administrator');
  await col('users').deleteOne({ _id: String(req.params.id) as any });
  audit(ctxOf(req), 'user.delete', 'user', req.params.id, { role: target.role });
  res.status(204).end();
}));
