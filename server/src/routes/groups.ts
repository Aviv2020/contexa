import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { auditFrom, auditStmt } from '../lib/audit';
import { activeOrgUserIds, bumpRevStmt, createContextWithGroup, headerOf, loadGroup } from '../lib/groups';
import { fail, now, parseJson } from '../lib/http';
import { getSettings } from '../lib/settings';
import { groupMemberIds, notifyUsers } from '../lib/realtime';
import { assertNotManaged } from '../middleware';

const groups = new Hono<AppEnv>();

/** Organisation info for the active org: settings, context type, doc types. */
groups.get('/org', async (c) => {
  const { orgId, role, mode } = c.get('org');
  const [org, ctype, docTypes, settings] = await Promise.all([
    c.env.CENTRAL_DB.prepare('SELECT id, name, mode, owner_user_id AS ownerUserId, recovery_public_key AS recoveryPublicKey FROM organizations WHERE id = ?').bind(orgId).first(),
    c.env.ORG_DB.prepare('SELECT label, label_plural AS labelPlural, icon, header_fields AS headerFields FROM context_types WHERE org_id = ?').bind(orgId).first<{ headerFields: string }>(),
    c.env.ORG_DB.prepare('SELECT id, name FROM doc_types WHERE org_id = ? AND active = 1 ORDER BY sort, name').bind(orgId).all(),
    getSettings(c.env, orgId),
  ]);
  return c.json({
    org,
    role,
    mode,
    contextType: ctype ? { ...ctype, headerFields: parseJson(ctype.headerFields, []) } : null,
    docTypes: docTypes.results,
    settings,
    plugins: [], // phase B
  });
});

/** Active organisation members (mention picker, add-member picker, display names + job titles). */
groups.get('/org/members', async (c) => {
  const { results } = await c.env.CENTRAL_DB.prepare(
    `SELECT m.user_id AS id, COALESCE(NULLIF(m.display_name, ''), u.name) AS name, m.job_title AS jobTitle, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active' ORDER BY name`,
  ).bind(c.get('org').orgId).all();
  return c.json({ members: results });
});

/**
 * Group list (§4.2.4): sorted by last activity; search by name, id and header fields;
 * filters all / unread / pinned / archived. Admins can pass scope=all to see every group in the org.
 */
groups.get('/groups', async (c) => {
  const { orgId, role } = c.get('org');
  const { userId } = c.get('auth');
  const filter = c.req.query('filter') ?? 'all';
  const q = (c.req.query('q') ?? '').trim();
  const scopeAll = c.req.query('scope') === 'all' && role === 'admin';
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  const where: string[] = ['g.org_id = ?'];
  const args: unknown[] = [userId, userId, orgId];
  if (!scopeAll) where.push('gm.user_id IS NOT NULL');
  if (filter === 'archived') where.push('x.archived_at IS NOT NULL');
  else if (!q) where.push('x.archived_at IS NULL'); // archived groups still appear in search results
  if (filter === 'unread') where.push('g.last_seq > COALESCE(s.last_read_seq, 0)');
  if (filter === 'pinned') where.push('COALESCE(s.pinned, 0) = 1');
  if (q) {
    where.push("(x.name LIKE ? ESCAPE '\\' OR x.display_id LIKE ? ESCAPE '\\' OR x.header LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    args.push(like, like, like);
  }
  args.push(limit, offset);
  const { results } = await c.env.ORG_DB.prepare(
    `SELECT g.id, g.context_id AS contextId, x.name, x.display_id AS displayId, x.photo_key AS photoKey, x.header, x.archived_at AS archivedAt,
            x.managed_by AS managedBy, g.last_seq AS lastSeq, g.last_activity_at AS lastActivityAt, g.last_message_id AS lastMessageId,
            COALESCE(s.pinned, 0) AS pinned, COALESCE(s.muted_until, 0) AS mutedUntil, COALESCE(s.last_read_seq, 0) AS lastReadSeq,
            gm.user_id IS NOT NULL AS isMember
       FROM groups g JOIN contexts x ON x.id = g.context_id
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.removed_at IS NULL
       LEFT JOIN group_user_state s ON s.group_id = g.id AND s.user_id = ?
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(s.pinned, 0) DESC, g.last_activity_at DESC LIMIT ? OFFSET ?`,
  ).bind(...args).all<Record<string, unknown> & { header: string; lastSeq: number; lastReadSeq: number }>();

  // Last message metadata for previews (content is encrypted — the device decrypts the preview).
  const lastIds = results.map((r) => r.lastMessageId).filter(Boolean) as string[];
  const lastMsgs = new Map<string, unknown>();
  if (lastIds.length) {
    const { results: msgs } = await c.env.ORG_DB.prepare(
      `SELECT id, sender_id AS senderId, kind, ciphertext, key_version AS keyVersion, created_at AS createdAt, deleted_at AS deletedAt FROM messages WHERE id IN (${lastIds.map(() => '?').join(',')})`,
    ).bind(...lastIds).all<{ id: string }>();
    for (const m of msgs) lastMsgs.set(m.id, m);
  }
  return c.json({
    groups: results.map((r) => ({
      ...r,
      header: parseJson(r.header, {}),
      unread: Math.max(0, r.lastSeq - r.lastReadSeq),
      pinned: !!r.pinned,
      isMember: !!r.isMember,
      lastMessage: r.lastMessageId ? lastMsgs.get(r.lastMessageId as string) ?? null : null,
    })),
  });
});

/** Create a context (and its group) manually (§4.2.1). */
groups.post('/contexts', async (c) => {
  const { orgId, role } = c.get('org');
  const { userId } = c.get('auth');
  assertNotManaged(c, 'contexts');
  const settings = await getSettings(c.env, orgId);
  if (role !== 'admin' && !settings.permissions.usersCreateContexts) fail(403, 'not_allowed');
  const body = await c.req.json<{ name: string; displayId?: string; header?: Record<string, string>; memberIds?: string[] }>();
  if (!body.name?.trim() || body.name.length > 120) fail(422, 'invalid_name');
  const requested = [...new Set([...(body.memberIds ?? []), ...(role === 'admin' ? [] : [userId])])];
  const valid = await activeOrgUserIds(c.env, orgId, requested);
  const r = await createContextWithGroup(c.env, orgId, { name: body.name, displayId: body.displayId, header: sanitizeHeader(body.header), createdBy: userId, memberIds: [...valid] });
  await c.env.ORG_DB.batch([auditStmt(c.env, auditFrom(c, 'context.create', 'context', r.contextId))]);
  await notifyUsers(c.env, [...valid], { t: 'sync', orgId, groupId: r.groupId });
  return c.json(r, 201);
});

groups.patch('/contexts/:id', async (c) => {
  const { orgId, role } = c.get('org');
  if (role !== 'admin') fail(403, 'admin_only');
  assertNotManaged(c, 'contexts');
  const body = await c.req.json<{ name?: string; displayId?: string; header?: Record<string, string>; archived?: boolean }>();
  const ctx = await c.env.ORG_DB.prepare('SELECT id FROM contexts WHERE id = ? AND org_id = ?').bind(c.req.param('id'), orgId).first();
  if (!ctx) fail(404, 'context_not_found');
  const sets: string[] = ['updated_at = ?'];
  const args: unknown[] = [now()];
  if (body.name !== undefined) {
    if (!body.name.trim()) fail(422, 'invalid_name');
    sets.push('name = ?');
    args.push(body.name.trim());
  }
  if (body.displayId !== undefined) (sets.push('display_id = ?'), args.push(body.displayId.trim()));
  if (body.header !== undefined) (sets.push('header = ?'), args.push(JSON.stringify(sanitizeHeader(body.header))));
  if (body.archived !== undefined) (sets.push('archived_at = ?'), args.push(body.archived ? now() : null));
  await c.env.ORG_DB.batch([
    c.env.ORG_DB.prepare(`UPDATE contexts SET ${sets.join(', ')} WHERE id = ?`).bind(...args, c.req.param('id')),
    auditStmt(c.env, auditFrom(c, body.archived === undefined ? 'context.update' : body.archived ? 'context.archive' : 'context.unarchive', 'context', c.req.param('id'))),
  ]);
  const g = await c.env.ORG_DB.prepare('SELECT id FROM groups WHERE context_id = ?').bind(c.req.param('id')).first<{ id: string }>();
  if (g) await notifyUsers(c.env, await groupMemberIds(c.env, g.id), { t: 'sync', orgId, groupId: g.id });
  return c.json({ ok: true });
});

/** Group header (§4.2.3): context fields, members with job titles, receipts state, archive count. */
groups.get('/groups/:id', async (c) => {
  const { orgId, mode } = c.get('org');
  const { userId } = c.get('auth');
  const { group, isMember } = await loadGroup(c, c.req.param('id'));
  const { results: members } = await c.env.ORG_DB.prepare(
    `SELECT gm.user_id AS id, COALESCE(s.last_read_seq, 0) AS lastReadSeq, COALESCE(s.last_delivered_seq, 0) AS lastDeliveredSeq
       FROM group_members gm LEFT JOIN group_user_state s ON s.group_id = gm.group_id AND s.user_id = gm.user_id
      WHERE gm.group_id = ? AND gm.removed_at IS NULL`,
  ).bind(group.id).all<{ id: string; lastReadSeq: number; lastDeliveredSeq: number }>();
  const profiles = new Map<string, { name: string; jobTitle: string; role: string }>();
  if (members.length) {
    const { results } = await c.env.CENTRAL_DB.prepare(
      `SELECT m.user_id, COALESCE(NULLIF(m.display_name, ''), u.name) AS name, m.job_title AS jobTitle, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.user_id IN (${members.map(() => '?').join(',')})`,
    ).bind(orgId, ...members.map((m) => m.id)).all<{ user_id: string; name: string; jobTitle: string; role: string }>();
    for (const p of results) profiles.set(p.user_id, p);
  }
  const state = await c.env.ORG_DB.prepare('SELECT pinned, muted_until AS mutedUntil, last_read_seq AS lastReadSeq FROM group_user_state WHERE group_id = ? AND user_id = ?')
    .bind(group.id, userId).first<{ pinned: number; mutedUntil: number; lastReadSeq: number }>();
  const archiveCount = await c.env.ORG_DB.prepare('SELECT COUNT(*) AS n FROM archive_docs WHERE context_id = ? AND removed_at IS NULL').bind(group.context_id).first<{ n: number }>();
  const settings = await getSettings(c.env, orgId);
  c.executionCtx.waitUntil(c.env.ORG_DB.prepare('INSERT INTO audit_log (org_id, at, actor_user_id, actor_device_id, action, target_type, target_id) VALUES (?,?,?,?,?,?,?)')
    .bind(orgId, now(), userId, c.get('auth').deviceId, 'group.view', 'group', group.id).run());
  return c.json({
    id: group.id,
    context: { id: group.context_id, name: group.ctx_name, displayId: group.display_id, photoKey: group.photo_key, header: headerOf(group), archivedAt: group.archived_at, managedBy: group.managed_by },
    lastSeq: group.last_seq,
    keyVersion: group.key_version,
    minKeyVersion: group.min_key_version,
    isMember,
    membersManagedBy: mode === 'connected' ? group.managed_by : null,
    canAddMembers: mode === 'standalone' && (c.get('org').role === 'admin' || (isMember && settings.permissions.membersAddMembers)),
    members: members.map((m) => ({ ...m, ...(profiles.get(m.id) ?? { name: '', jobTitle: '', role: 'user' }) })),
    me: { pinned: !!state?.pinned, mutedUntil: state?.mutedUntil ?? 0, lastReadSeq: state?.lastReadSeq ?? 0 },
    archiveCount: archiveCount?.n ?? 0,
  });
});

groups.post('/groups/:id/members', async (c) => {
  const { orgId, role } = c.get('org');
  assertNotManaged(c, 'members');
  const { group, isMember } = await loadGroup(c, c.req.param('id'));
  const settings = await getSettings(c.env, orgId);
  if (role !== 'admin' && !(isMember && settings.permissions.membersAddMembers)) fail(403, 'not_allowed');
  const { userIds } = await c.req.json<{ userIds: string[] }>();
  const valid = await activeOrgUserIds(c.env, orgId, userIds ?? []); // only members of the same org (§4.2.2)
  if (!valid.size) fail(422, 'no_valid_users');
  const t = now();
  const { userId } = c.get('auth');
  const stmts: D1PreparedStatement[] = [];
  for (const uid of valid) {
    stmts.push(
      c.env.ORG_DB.prepare(
        `INSERT INTO group_members (group_id, user_id, org_id, added_by, added_at) VALUES (?,?,?,?,?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at`,
      ).bind(group.id, uid, orgId, userId, t),
      auditStmt(c.env, auditFrom(c, 'group.member_add', 'group', group.id, { userId: uid })),
    );
  }
  // New members see the full history (§4.2.2): queue key wraps for each of their devices.
  const ids = [...valid];
  const { results: devs } = await c.env.CENTRAL_DB.prepare(`SELECT id FROM devices WHERE revoked_at IS NULL AND user_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all<{ id: string }>();
  for (const d of devs) stmts.push(c.env.ORG_DB.prepare('INSERT OR IGNORE INTO key_requests (group_id, device_id, created_at) VALUES (?,?,?)').bind(group.id, d.id, t));
  await c.env.ORG_DB.batch(stmts);
  const members = await groupMemberIds(c.env, group.id);
  await notifyUsers(c.env, members, { t: 'keys', orgId, groupId: group.id });
  await notifyUsers(c.env, members, { t: 'sync', orgId, groupId: group.id });
  return c.json({ added: ids });
});

groups.delete('/groups/:id/members/:userId', async (c) => {
  const { orgId, role } = c.get('org');
  assertNotManaged(c, 'members');
  if (role !== 'admin') fail(403, 'admin_only');
  const { group } = await loadGroup(c, c.req.param('id'));
  const target = c.req.param('userId');
  await removeFromGroups(c.env, orgId, target, [group.id]);
  await c.env.ORG_DB.batch([auditStmt(c.env, auditFrom(c, 'group.member_remove', 'group', group.id, { userId: target }))]);
  await notifyUsers(c.env, [target], { t: 'wipe', orgId, reason: 'removed_from_group', groupId: group.id });
  await notifyUsers(c.env, await groupMemberIds(c.env, group.id), { t: 'sync', orgId, groupId: group.id });
  return c.json({ ok: true });
});

/**
 * Removal: immediate loss of access, removal of the user's key wraps, and a forced key rotation —
 * the next sender must create a new group key version wrapped only for the remaining members (§6.5).
 */
export async function removeFromGroups(env: AppEnv['Bindings'], orgId: string, userId: string, groupIds: string[]) {
  if (!groupIds.length) return;
  const { results: devs } = await env.CENTRAL_DB.prepare('SELECT id FROM devices WHERE user_id = ?').bind(userId).all<{ id: string }>();
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const gid of groupIds) {
    stmts.push(
      env.ORG_DB.prepare('UPDATE group_members SET removed_at = ? WHERE group_id = ? AND user_id = ? AND removed_at IS NULL').bind(t, gid, userId),
      env.ORG_DB.prepare('UPDATE groups SET min_key_version = key_version + 1 WHERE id = ? AND org_id = ?').bind(gid, orgId),
    );
    for (const d of devs) {
      stmts.push(
        env.ORG_DB.prepare('DELETE FROM group_keys WHERE group_id = ? AND device_id = ?').bind(gid, d.id),
        env.ORG_DB.prepare('DELETE FROM key_requests WHERE group_id = ? AND device_id = ?').bind(gid, d.id),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 90) await env.ORG_DB.batch(stmts.slice(i, i + 90));
}

groups.put('/groups/:id/state', async (c) => {
  const { group } = await loadGroup(c, c.req.param('id'));
  const body = await c.req.json<{ pinned?: boolean; mutedUntil?: number }>();
  const { userId } = c.get('auth');
  await c.env.ORG_DB.prepare('INSERT OR IGNORE INTO group_user_state (group_id, user_id) VALUES (?, ?)').bind(group.id, userId).run();
  if (body.pinned !== undefined) await c.env.ORG_DB.prepare('UPDATE group_user_state SET pinned = ? WHERE group_id = ? AND user_id = ?').bind(body.pinned ? 1 : 0, group.id, userId).run();
  if (body.mutedUntil !== undefined) {
    if (!Number.isInteger(body.mutedUntil) || body.mutedUntil < -1) fail(422, 'invalid_muted_until');
    await c.env.ORG_DB.prepare('UPDATE group_user_state SET muted_until = ? WHERE group_id = ? AND user_id = ?').bind(body.mutedUntil, group.id, userId).run();
  }
  return c.json({ ok: true });
});

/** Batched receipts (§7.7): devices debounce and send the highest delivered/read seq. */
groups.post('/groups/:id/receipts', async (c) => {
  const { orgId } = c.get('org');
  const { group, isMember } = await loadGroup(c, c.req.param('id'));
  if (!isMember) return c.json({ ok: true }); // admins browsing a group don't produce receipts
  const body = await c.req.json<{ readSeq?: number; deliveredSeq?: number }>();
  const { userId } = c.get('auth');
  const read = Math.min(Math.max(0, Number(body.readSeq ?? 0)), group.last_seq);
  const delivered = Math.min(Math.max(read, Number(body.deliveredSeq ?? 0)), group.last_seq);
  await c.env.ORG_DB.prepare(
    `INSERT INTO group_user_state (group_id, user_id, last_read_seq, last_delivered_seq) VALUES (?,?,?,?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq), last_delivered_seq = MAX(last_delivered_seq, excluded.last_delivered_seq)`,
  ).bind(group.id, userId, read, delivered).run();
  c.executionCtx.waitUntil(groupMemberIds(c.env, group.id).then((ids) => notifyUsers(c.env, ids.filter((i) => i !== userId), { t: 'sync', orgId, groupId: group.id })));
  return c.json({ ok: true });
});

/** Device-reported security events, e.g. a screenshot detected on iOS (§6.1). */
groups.post('/security-events', async (c) => {
  const body = await c.req.json<{ type: 'screenshot' | 'jailbreak_detected'; groupId?: string }>();
  if (!['screenshot', 'jailbreak_detected'].includes(body.type)) fail(422, 'invalid_type');
  await c.env.ORG_DB.batch([auditStmt(c.env, auditFrom(c, `security.${body.type}`, body.groupId ? 'group' : undefined, body.groupId))]);
  return c.json({ ok: true });
});

function sanitizeHeader(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {}).slice(0, 20)) {
    if (/^[\w-]{1,40}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

export { bumpRevStmt };
export default groups;
