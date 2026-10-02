import { Router } from 'express';
import { z } from 'zod';
import { q } from '../db';
import { getRules, invalidateRules } from '../services/rules';
import { asyncH, HttpError } from '../util';

export const rulesRouter = Router();

rulesRouter.get('/', asyncH(async (_req, res) => res.json(await getRules())));

rulesRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ threshold: z.number().finite().optional(), enabled: z.boolean().optional() }).parse(req.body);
  const rows = await q(
    'UPDATE rules SET threshold=COALESCE($2, threshold), enabled=COALESCE($3, enabled) WHERE id=$1 RETURNING *',
    [req.params.id, b.threshold ?? null, b.enabled ?? null],
  );
  if (!rows.length) throw new HttpError(404, 'Rule not found');
  invalidateRules();
  res.json(rows[0]);
}));
