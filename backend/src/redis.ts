import Redis from 'ioredis';
import { config } from './config';

/**
 * Redis holds the hot, short-lived state so the dashboard never has to hit
 * PostgreSQL for "what is happening right now":
 *   hb:{id}      heartbeat key with a TTL - expiry == device went silent
 *   latest:{id}  most recent metrics (JSON)
 *   recent:{id}  rolling window of the last N readings (list) used by the predictor
 *   cache:*      short-lived response caches
 */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

export const RECENT_MAX = 120;

export const keys = {
  hb: (id: string) => `hb:${id}`,
  latest: (id: string) => `latest:${id}`,
  recent: (id: string) => `recent:${id}`,
};

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  return value;
}
