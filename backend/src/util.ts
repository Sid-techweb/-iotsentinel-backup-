import { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) =>
    fn(req, res).catch(next);

const camelKey = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case DB rows -> camelCase API objects. */
export function camelize<T = any>(row: any): T {
  if (Array.isArray(row)) return row.map(camelize) as any;
  if (row instanceof Date || row === null || typeof row !== 'object') return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
