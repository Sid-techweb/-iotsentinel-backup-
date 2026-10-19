import Redis from 'ioredis';
import { Response } from 'express';
import { config } from '../config';
import { redis } from '../redis';

/**
 * Real-time push. Any part of the backend can publish an event to a Redis channel;
 * every API instance subscribes to that channel and fans the event out to its open
 * Server-Sent-Events connections, so dashboards update the moment something changes.
 */
export type EventType = 'kb' | 'chat' | 'tick' | 'alert' | 'incident' | 'firmware' | 'device' | 'rules' | 'model' | 'webhook' | 'user';

const CHANNEL = 'sentinel:events';
const MAX_CLIENTS = 200;
const clients = new Set<Response>();

export function publish(type: EventType, data: Record<string, unknown> = {}) {
  redis.publish(CHANNEL, JSON.stringify({ type, data, ts: Date.now() })).catch(() => { /* push is best-effort */ });
}

let lastTick = 0;
/** Fresh telemetry arrived. Throttled to one event per second however many devices report. */
export function publishTick() {
  const now = Date.now();
  if (now - lastTick < 1000) return;
  lastTick = now;
  publish('tick');
}

/** Register an SSE response. Returns false when the server is at its connection limit. */
export function addClient(res: Response): boolean {
  if (clients.size >= MAX_CLIENTS) return false;
  clients.add(res);
  res.on('close', () => clients.delete(res));
  return true;
}

export const clientCount = () => clients.size;

let sub: Redis | null = null;
let ping: NodeJS.Timeout | null = null;

export function startEventBus() {
  sub = new Redis(config.redisUrl);
  sub.subscribe(CHANNEL).catch((e) => console.error('[events] subscribe failed', e));
  sub.on('message', (_channel, message) => {
    let type = 'message';
    try { type = JSON.parse(message).type; } catch { /* forward as-is */ }
    for (const res of clients) res.write(`event: ${type}\ndata: ${message}\n\n`);
  });
  // keep proxies from closing idle connections
  ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  ping.unref();
}

export async function stopEventBus() {
  if (ping) clearInterval(ping);
  for (const res of clients) res.end();
  clients.clear();
  if (sub) await sub.quit().catch(() => undefined);
  sub = null;
}
