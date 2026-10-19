import crypto from 'crypto';
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

/** Device keys are random 128-bit values, so a fast SHA-256 is enough and keeps ingest lookups O(1). */
export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
export const newDeviceKey = () => crypto.randomBytes(16).toString('hex');

/** CSV with RFC 4180 quoting; cells that start like a spreadsheet formula are neutralised (CSV injection). */
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Header line / body lines separately, so large exports can be streamed in batches. */
export const csvHeader = (columns: { header: string }[]) => columns.map((c) => csvCell(c.header)).join(',') + '\r\n';
export const csvBody = (rows: Record<string, unknown>[], columns: { key: string }[]) => rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(',') + '\r\n').join('');
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; header: string }[]): string {
  return csvHeader(columns) + csvBody(rows, columns);
}
