import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';

export interface AuditEntry {
  orgId: string | null;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

export function auditStmt(env: Env, e: AuditEntry): D1PreparedStatement {
  return env.ORG_DB.prepare(
    'INSERT INTO audit_log (org_id, at, actor_user_id, actor_device_id, action, target_type, target_id, meta, ip) VALUES (?,?,?,?,?,?,?,?,?)',
  ).bind(e.orgId, Date.now(), e.actorUserId ?? null, e.actorDeviceId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.meta ? JSON.stringify(e.meta) : null, e.ip ?? null);
}

export async function audit(env: Env, e: AuditEntry): Promise<void> {
  await auditStmt(env, e).run();
}

/** Audit helper bound to the current request's actor and org. */
export function auditFrom(c: Context<AppEnv>, action: string, targetType?: string, targetId?: string, meta?: Record<string, unknown>): AuditEntry {
  return {
    orgId: c.get('org')?.orgId ?? null,
    actorUserId: c.get('auth')?.userId,
    actorDeviceId: c.get('auth')?.deviceId,
    action,
    targetType,
    targetId,
    meta,
    ip: c.req.header('cf-connecting-ip') ?? null,
  };
}
