import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { col, nextId, toApi, toApiList } from '../mongo';
import { audit, ctxOf } from '../services/audit';
import { assertSafeUrl, deliver, getWebhook, WEBHOOK_EVENTS } from '../services/webhooks';
import { asyncH, HttpError } from '../util';

export const webhooksRouter = Router();
// webhook URLs often embed tokens (Slack, Discord), so even reading them is admin-only
webhooksRouter.use(requireAdmin);

const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event').transform((e) => [...new Set(e)]);
const hide = ({ secret: _secret, ...rest }: any) => rest;

webhooksRouter.get('/', asyncH(async (_req, res) => {
  const hooks = await col('webhooks').find({}).sort({ _id: 1 }).toArray();
  const rows = await Promise.all(hooks.map(async (h) => {
    const d = await col('webhook_deliveries').find({ webhookId: h._id as unknown as number }).sort({ _id: -1 }).limit(1).next();
    return { ...toApi(h)!, lastDelivery: d ? { ok: d.ok, statusCode: d.statusCode, error: d.error, createdAt: d.createdAt } : null };
  }));
  res.json({ events: WEBHOOK_EVENTS, webhooks: rows.map(hide) });
}));

webhooksRouter.post('/', asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60), url: z.string().trim().max(500), events }).parse(req.body);
  await assertSafeUrl(b.url);
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const row = toApi({ _id: await nextId('webhooks'), name: b.name, url: b.url, secret, events: b.events, enabled: true, createdAt: new Date() }) as any;
  await col('webhooks').insertOne({ _id: row.id, name: b.name, url: b.url, secret, events: b.events, enabled: true, createdAt: row.createdAt });
  audit(ctxOf(req), 'webhook.create', 'webhook', row.id, { name: b.name, host: new URL(b.url).host, events: b.events });
  res.status(201).json({ ...hide(row), secret }); // the signing secret is shown only now
}));

webhooksRouter.put('/:id', asyncH(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60).optional(), url: z.string().trim().max(500).optional(), events: events.optional(), enabled: z.boolean().optional() }).parse(req.body);
  if (b.url) await assertSafeUrl(b.url);
  const set: Record<string, unknown> = {};
  for (const k of ['name', 'url', 'events', 'enabled'] as const) if (b[k] !== undefined) set[k] = b[k];
  const id = Number(req.params.id);
  const row = toApi(Object.keys(set).length
    ? await col('webhooks').findOneAndUpdate({ _id: id as any }, { $set: set }, { returnDocument: 'after' })
    : await col('webhooks').findOne({ _id: id as any }));
  if (!row) throw new HttpError(404, 'Webhook not found');
  audit(ctxOf(req), 'webhook.update', 'webhook', req.params.id, { changed: Object.keys(b) });
  res.json(hide(row));
}));

webhooksRouter.delete('/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const r = await col('webhooks').deleteOne({ _id: id as any });
  if (!r.deletedCount) throw new HttpError(404, 'Webhook not found');
  await col('webhook_deliveries').deleteMany({ webhookId: id });
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
  res.json(toApiList(await col('webhook_deliveries').find({ webhookId: Number(req.params.id) }).sort({ _id: -1 }).limit(30).toArray()).map(({ webhookId: _w, ...d }) => d));
}));
