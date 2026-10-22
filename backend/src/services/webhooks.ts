import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { config } from '../config';
import { col, nextId, toApi } from '../mongo';
import { HttpError } from '../util';

export const WEBHOOK_EVENTS = ['alert.critical', 'alert.predictive', 'incident.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook { id: number; name: string; url: string; secret: string; events: WebhookEvent[]; enabled: boolean }

/** Loopback, private, link-local and carrier-grade-NAT ranges - never a valid public destination. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Webhook URLs are entered by admins but still must not let the server be pointed at
 * internal services (database, Redis, cloud metadata). Checked on save AND on every send,
 * so a DNS name that later resolves to a private address is refused too.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'That is not a valid URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Webhook URLs must start with http:// or https://');
  if (config.allowPrivateWebhooks) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `Could not resolve ${host}`);
  if (addrs.some(isPrivateIp)) throw new HttpError(400, 'Webhook URLs may not point at private or local network addresses');
  return url;
}

export const sign = (secret: string, body: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

export async function deliver(hook: Webhook, event: string, data: Record<string, unknown>, summary: string) {
  const started = Date.now();
  let ok = false;
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const url = await assertSafeUrl(hook.url);
    // `text` / `content` make the same payload usable by Slack and Discord incoming webhooks
    const body = JSON.stringify({ event, sentAt: new Date().toISOString(), text: summary, content: summary, data });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'IoT-Sentinel/1.0',
        'x-sentinel-event': event,
        'x-sentinel-signature': sign(hook.secret, body),
      },
      body,
      redirect: 'manual', // a redirect could bounce the request to an internal address
      signal: AbortSignal.timeout(5000),
    });
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) error = `Receiver answered HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const durationMs = Date.now() - started;
  await (async () => {
    await col('webhook_deliveries').insertOne({ _id: (await nextId('webhook_deliveries')) as any, webhookId: hook.id, event, ok, statusCode, error, durationMs, createdAt: new Date() });
    // keep only the latest 100 deliveries per webhook
    const oldest = await col('webhook_deliveries').find({ webhookId: hook.id }).sort({ _id: -1 }).skip(100).limit(1).next();
    if (oldest) await col('webhook_deliveries').deleteMany({ webhookId: hook.id, _id: { $lte: oldest._id } });
  })().catch(() => undefined);
  return { ok, statusCode, error, durationMs };
}

/** Fire-and-forget: notify every enabled webhook subscribed to this event. Never throws. */
export function notify(event: WebhookEvent, data: Record<string, unknown>, summary: string) {
  void (async () => {
    try {
      const hooks = (await col('webhooks').find({ enabled: true, events: event }).toArray()).map((h) => toApi<Webhook>(h)!);
      await Promise.all(hooks.map((h) => deliver(h, event, data, summary)));
    } catch (e) {
      console.error('[webhooks]', e);
    }
  })();
}

export const getWebhook = async (id: number | string) => toApi<Webhook>(await col('webhooks').findOne({ _id: Number(id) as any }));
