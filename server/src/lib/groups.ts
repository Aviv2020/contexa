import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { fail, now, parseJson } from './http';
import { randomId } from './crypto';

export interface GroupRow {
  id: string;
  org_id: string;
  context_id: string;
  last_seq: number;
  last_activity_at: number;
  key_version: number;
  min_key_version: number;
  ctx_name: string;
  display_id: string;
  photo_key: string | null;
  header: string;
  managed_by: string | null;
  archived_at: number | null;
}

export interface GroupAccess {
  group: GroupRow;
  isMember: boolean;
  isAdmin: boolean;
}

/** Members read and write; admins may read every group in their org (§3.2). */
export async function loadGroup(c: Context<AppEnv>, groupId: string, need: 'read' | 'write' = 'read'): Promise<GroupAccess> {
  const { orgId, role } = c.get('org');
  const { userId } = c.get('auth');
  const group = await c.env.ORG_DB.prepare(
    `SELECT g.*, x.name AS ctx_name, x.display_id, x.photo_key, x.header, x.managed_by, x.archived_at,
            (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ? AND gm.removed_at IS NULL) AS is_member
       FROM groups g JOIN contexts x ON x.id = g.context_id WHERE g.id = ? AND g.org_id = ?`,
  ).bind(userId, groupId, orgId).first<GroupRow & { is_member: number | null }>();
  if (!group) fail(404, 'group_not_found');
  const isMember = !!group.is_member;
  const isAdmin = role === 'admin';
  if (!isMember && !isAdmin) fail(403, 'not_a_group_member');
  if (need === 'write') {
    if (!isMember) fail(403, 'not_a_group_member');
    if (group.archived_at) fail(403, 'group_archived');
  }
  return { group, isMember, isAdmin };
}

/** Next org-wide revision number for delta sync (D1 serialises writes, so this is atomic). */
export function bumpRevStmt(env: Env, orgId: string): D1PreparedStatement {
  return env.ORG_DB.prepare('UPDATE org_settings SET rev = rev + 1 WHERE org_id = ?').bind(orgId);
}
export const REV_SUBQUERY = '(SELECT rev FROM org_settings WHERE org_id = ?)';

export async function createContextWithGroup(
  env: Env,
  orgId: string,
  input: { name: string; displayId?: string; externalId?: string | null; header?: Record<string, string>; createdBy: string; memberIds: string[] },
): Promise<{ contextId: string; groupId: string }> {
  const t = now();
  const contextId = randomId();
  const groupId = randomId();
  const stmts = [
    env.ORG_DB.prepare('INSERT INTO contexts (id, org_id, external_id, name, display_id, header, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(contextId, orgId, input.externalId ?? null, input.name.trim(), (input.displayId ?? '').trim(), JSON.stringify(input.header ?? {}), input.createdBy, t, t),
    env.ORG_DB.prepare('INSERT INTO groups (id, org_id, context_id, last_activity_at) VALUES (?,?,?,?)').bind(groupId, orgId, contextId, t),
    ...[...new Set(input.memberIds)].map((uid) =>
      env.ORG_DB.prepare('INSERT INTO group_members (group_id, user_id, org_id, added_by, added_at) VALUES (?,?,?,?,?)').bind(groupId, uid, orgId, input.createdBy, t),
    ),
  ];
  await env.ORG_DB.batch(stmts);
  return { contextId, groupId };
}

export async function activeOrgUserIds(env: Env, orgId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.CENTRAL_DB.prepare(`SELECT user_id FROM memberships WHERE org_id = ? AND status = 'active' AND user_id IN (${ph})`)
    .bind(orgId, ...ids).all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

export function groupTitle(g: { ctx_name: string; display_id: string }): string {
  return g.display_id ? `${g.ctx_name} · ${g.display_id}` : g.ctx_name;
}

export function headerOf(g: { header: string }): Record<string, string> {
  return parseJson(g.header, {});
}
