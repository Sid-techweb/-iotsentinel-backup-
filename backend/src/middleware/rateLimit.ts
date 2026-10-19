import { Request, RequestHandler } from 'express';
import { config } from '../config';
import { redis } from '../redis';
import { HttpError, hashKey } from '../util';

interface Options {
  name: string;
  max: number;
  windowSec?: number;
  /** what to count by; defaults to the client IP */
  by?: (req: Request) => string;
}

/**
 * Fixed-window rate limiter backed by Redis, so the limit holds across several API instances.
 * It fails open: if Redis is unavailable requests are allowed rather than blocked.
 */
export function rateLimit({ name, max, windowSec = 60, by }: Options): RequestHandler {
  return async (req, res, next) => {
    if (!config.rateLimit) return next();
    try {
      const who = by ? by(req) : req.ip ?? 'unknown';
      const bucket = Math.floor(Date.now() / (windowSec * 1000));
      const key = `rl:${name}:${who}:${bucket}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowSec + 1);
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - n)));
      if (n > max) {
        res.setHeader('Retry-After', String(windowSec));
        return next(new HttpError(429, 'Too many requests - slow down and retry shortly'));
      }
    } catch {
      /* fail open */
    }
    next();
  };
}

/** Counts per device key (hashed) so one noisy or abusive device cannot starve the rest. */
export const byDeviceKey = (req: Request) => hashKey(String(req.header('x-api-key') ?? 'none')).slice(0, 16);
