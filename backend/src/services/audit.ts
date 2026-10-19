import { Request } from 'express';
import { q } from '../db';

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
  let json = JSON.stringify(details ?? {});
  if (json.length > MAX_DETAILS) json = JSON.stringify({ truncated: true, preview: json.slice(0, MAX_DETAILS - 40) });
  q(
    'INSERT INTO audit_logs (user_id, user_email, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
    [ctx.userId ?? null, ctx.userEmail ?? null, action, entity ?? null, entityId === undefined || entityId === null ? null : String(entityId), json, ctx.ip ?? null],
  ).catch((e) => console.error('[audit] could not write entry', action, e.message));
}

export interface AuditFilter { action?: string; userId?: string; entity?: string; before?: number; limit?: number }

export async function listAudit(f: AuditFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.action) { params.push(`${f.action}%`); where.push(`action LIKE $${params.length}`); }
  if (f.userId) { params.push(f.userId); where.push(`user_id = $${params.length}`); }
  if (f.entity) { params.push(f.entity); where.push(`entity = $${params.length}`); }
  if (f.before) { params.push(f.before); where.push(`id < $${params.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  return q(`SELECT id, user_id, user_email, action, entity, entity_id, details, ip, created_at FROM audit_logs
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, params);
}
