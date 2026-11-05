import type { Env } from '../env';

/** A nudge only ("something changed in org X / group Y"); devices then run a delta sync (§7.7). */
export type HubEvent =
  | { t: 'sync'; orgId: string; groupId?: string }
  | { t: 'wipe'; orgId: string; reason: 'revoked' | 'deactivated' | 'removed_from_group'; groupId?: string }
  | { t: 'keys'; orgId: string; groupId: string };

export async function notifyUsers(env: Env, userIds: string[], event: HubEvent): Promise<void> {
  await Promise.all(
    [...new Set(userIds)].map((uid) =>
      env.USER_HUB.get(env.USER_HUB.idFromName(uid))
        .fetch('https://hub/notify', { method: 'POST', body: JSON.stringify(event) })
        .catch((e) => console.error('hub notify failed', uid, e)),
    ),
  );
}

export async function groupMemberIds(env: Env, groupId: string): Promise<string[]> {
  const { results } = await env.ORG_DB.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND removed_at IS NULL')
    .bind(groupId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export async function orgAdminIds(env: Env, orgId: string): Promise<string[]> {
  const { results } = await env.CENTRAL_DB.prepare("SELECT user_id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'")
    .bind(orgId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}
