import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { q, q1 } from '../db';
import { audit, ctxOf } from '../services/audit';
import { assertSafeUrl, deliver, getWebhook, WEBHOOK_EVENTS } from '../services/webhooks';
import { asyncH, HttpError } from '../util';

export const webhooksRouter = Router();
// webhook URLs often embed tokens (Slack, Discord), so even reading them is admin-only
webhooksRouter.use(requireAdmin);

const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event').transform((e) => [...new Set(e)]);
const hide = ({ secret: _secret, ...rest }: any) => rest;

webhooksRouter.get('/', asyncH(async (_req, res) => {
  const rows = await q(`
    SELECT w.*, (SELECT row_to_json(d) FROM (SELECT ok, status_code, error, created_at FROM webhook_deliveries WHERE webhook_id=w.id ORDER BY id DESC LIMIT 1) d) AS last_delivery
    FROM webhooks w ORDER BY w.id`);
  res.json({ events: WEBHOOK_EVENTS, webhooks: rows.map(hide) });
}));

webhooksRouter.post('/', asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), url: z.string().trim().max(500), events }).parse(req.body);
  await assertSafeUrl(b.url);
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const row = await q1('INSERT INTO webhooks (name, url, secret, events) VALUES ($1,$2,$3,$4) RETURNING *', [b.name, b.url, secret, b.events]);
  audit(ctxOf(req), 'webhook.create', 'webhook', row.id, { name: b.name, host: new URL(b.url).host, events: b.events });
  res.status(201).json({ ...hide(row), secret }); // the signing secret is shown only now
}));

webhooksRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), url: z.string().trim().max(500).optional(), events: events.optional(), enabled: z.boolean().optional() }).parse(req.body);
  if (b.url) await assertSafeUrl(b.url);
  const row = await q1(
    'UPDATE webhooks SET name=COALESCE($2,name), url=COALESCE($3,url), events=COALESCE($4,events), enabled=COALESCE($5,enabled) WHERE id=$1 RETURNING *',
    [req.params.id, b.name ?? null, b.url ?? null, b.events ?? null, b.enabled ?? null],
  );
  if (!row) throw new HttpError(404, 'Webhook not found');
  audit(ctxOf(req), 'webhook.update', 'webhook', req.params.id, { changed: Object.keys(b) });
  res.json(hide(row));
}));

webhooksRouter.delete('/:id', asyncH(async (req, res) => {
  const rows = await q('DELETE FROM webhooks WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Webhook not found');
  audit(ctxOf(req), 'webhook.delete', 'webhook', req.params.id);
  res.status(204).end();
}));

/** Send a sample event so the receiver can be checked before a real alert needs it. */
webhooksRouter.post('/:id/test', asyncH(async (req, res) => {
  const hook = await getWebhook(String(req.params.id));
  if (!hook) throw new HttpError(404, 'Webhook not found');
  audit(ctxOf(req), 'webhook.test', 'webhook', hook.id);
  res.json(await deliver(hook, 'test.ping', { message: 'This is a test event from IoT Sentinel' }, 'IoT Sentinel test notification'));
}));

webhooksRouter.get('/:id/deliveries', asyncH(async (req, res) => {
  res.json(await q('SELECT id, event, ok, status_code, error, duration_ms, created_at FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT 30', [req.params.id]));
}));
