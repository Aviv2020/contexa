import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Env, Role } from './env';
import { verifyJwt } from './lib/crypto';
import { fail } from './lib/http';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header('authorization');
  const token = h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('token');
  if (!token) fail(401, 'unauthenticated');
  const p = await verifyJwt(c.env.JWT_SECRET, token);
  if (!p) fail(401, 'invalid_token');
  const dev = await c.env.CENTRAL_DB.prepare('SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?').bind(p.dev, p.sub).first<{ revoked_at: number | null }>();
  if (!dev || dev.revoked_at) fail(401, 'device_revoked');
  c.set('auth', { userId: p.sub, deviceId: p.dev });
  await next();
};

/** Resolves the active organisation from the X-Org-Id header and checks membership + per-org device revocation. */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const orgId = c.req.header('x-org-id');
  if (!orgId) fail(400, 'missing_org');
  const { userId, deviceId } = c.get('auth');
  const row = await c.env.CENTRAL_DB.prepare(
    `SELECT m.role, m.status, m.last_active_month, o.mode, o.status AS org_status,
            (SELECT 1 FROM org_device_revocations r WHERE r.org_id = m.org_id AND r.device_id = ?) AS revoked
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ?`,
  ).bind(deviceId, orgId, userId).first<{ role: Role; status: string; last_active_month: string | null; mode: 'standalone' | 'connected'; org_status: string; revoked: number | null }>();
  if (!row || row.status === 'invited') fail(403, 'not_a_member');
  if (row.status === 'deactivated') fail(403, 'membership_deactivated', { wipe: true });
  if (row.revoked) fail(403, 'device_revoked_for_org', { wipe: true });
  if (row.org_status !== 'active') fail(403, 'org_suspended');
  // Billing (§3.5): a user counts as active in every org they used this month.
  const month = new Date().toISOString().slice(0, 7);
  if (row.last_active_month !== month) {
    c.executionCtx.waitUntil(
      c.env.CENTRAL_DB.prepare('UPDATE memberships SET last_active_month = ? WHERE org_id = ? AND user_id = ?').bind(month, orgId, userId).run(),
    );
  }
  c.set('org', { orgId, role: row.role, mode: row.mode });
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('org').role !== 'admin') fail(403, 'admin_only');
  await next();
};

/** In a connected org, plugin-owned domains are read-only in the app (§5.2). */
export function assertNotManaged(c: Context<AppEnv>, domain: 'users' | 'contexts' | 'members' | 'archive'): void {
  if (c.get('org').mode === 'connected') fail(409, 'managed_by_plugin', { domain });
}

export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<void> {
  const r = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key)).hit(limit, windowSec);
  if (!r.allowed) fail(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'local';
}
