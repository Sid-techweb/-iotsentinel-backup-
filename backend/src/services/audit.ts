import { Request } from 'express';
import { col, escapeRegex, nextId, toApiList } from '../mongo';

export interface AuditCtx {
  userId?: string | null;
  userEmail?: string | null;
  ip?: string | null;
}

/** Who is doing this and from where, taken from an authenticated request. */
export const ctxOf = (req: Request): AuditCtx => ({ userId: req.user?.id ?? null, userEmail: req.user?.email ?? null, ip: req.ip ?? null });

const MAX_DETAILS = 4000;

/**
 * Record a security-relevant action. It is fire-and-forget and never throws: a failure to write
 * the audit trail must not break the action itself (it is logged to stderr instead).
 * Callers pass only non-secret details - never passwords, tokens or device keys.
 */
export function audit(ctx: AuditCtx, action: string, entity?: string | null, entityId?: string | string[] | number | null, details: Record<string, unknown> = {}) {
  const raw = JSON.stringify(details ?? {});
  const safe = raw.length > MAX_DETAILS ? { truncated: true, preview: raw.slice(0, MAX_DETAILS - 40) } : JSON.parse(raw);
  nextId('audit_logs').then((id) => col('audit_logs').insertOne({
    _id: id as any, userId: ctx.userId ?? null, userEmail: ctx.userEmail ?? null, action, entity: entity ?? null,
    entityId: entityId === undefined || entityId === null ? null : String(entityId), details: safe, ip: ctx.ip ?? null, createdAt: new Date(),
  })).catch((e) => console.error('[audit] could not write entry', action, e.message));
}

export interface AuditFilter { action?: string; userId?: string; entity?: string; before?: number; limit?: number }

export async function listAudit(f: AuditFilter) {
  const filter: Record<string, unknown> = {};
  if (f.action) filter.action = { $regex: `^${escapeRegex(f.action)}` };
  if (f.userId) filter.userId = f.userId;
  if (f.entity) filter.entity = f.entity;
  if (f.before) filter._id = { $lt: f.before };
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  return toApiList(await col('audit_logs').find(filter).sort({ _id: -1 }).limit(limit).toArray());
}
