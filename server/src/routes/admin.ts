import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { audit, auditFrom, auditStmt } from '../lib/audit';
import { normalizePhone, randomId } from '../lib/crypto';
import { parseCsv, toCsv } from '../lib/csv';
import { activeOrgUserIds, createContextWithGroup } from '../lib/groups';
import { fail, now, parseJson } from '../lib/http';
import { sendSms } from '../lib/inforu';
import { notifyUsers } from '../lib/realtime';
import { saveSettings, getSettings, validateSettings, type OrgSettings } from '../lib/settings';
import { assertNotManaged, requireAdmin } from '../middleware';
import { removeFromGroups } from './groups';

/** In-app admin screens (§4.6). Admin role only. */
const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);

const INVITE_TTL_MS = 7 * 24 * 3600_000;

// ---- Users -----------------------------------------------------------------
admin.get('/users', async (c) => {
  const { results } = await c.env.CENTRAL_DB.prepare(
    `SELECT u.id, u.phone, COALESCE(NULLIF(m.display_name, ''), u.name) AS name, m.role, m.job_title AS jobTitle, m.status, m.managed_by AS managedBy,
            m.invite_expires_at AS inviteExpiresAt, m.created_at AS createdAt
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.status, name`,
  ).bind(c.get('org').orgId).all();
  return c.json({ users: results });
});

/** Personal, single-use, time-limited SMS invitation (§3.4). No open join links. */
admin.post('/users', async (c) => {
  assertNotManaged(c, 'users');
  const { orgId } = c.get('org');
  const body = await c.req.json<{ phone: string; name: string; role?: 'admin' | 'user'; jobTitle?: string }>();
  const phone = normalizePhone(body.phone ?? '');
  if (!phone) fail(422, 'invalid_phone');
  if (!body.name?.trim()) fail(422, 'invalid_name');
  const role = body.role === 'admin' ? 'admin' : 'user';
  const t = now();
  let user = await c.env.CENTRAL_DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first<{ id: string }>();
  if (!user) {
    user = { id: randomId() };
    await c.env.CENTRAL_DB.prepare('INSERT INTO users (id, phone, name, created_at) VALUES (?,?,?,?)').bind(user.id, phone, body.name.trim(), t).run();
  }
  const m = await c.env.CENTRAL_DB.prepare('SELECT status FROM memberships WHERE org_id = ? AND user_id = ?').bind(orgId, user.id).first<{ status: string }>();
  if (m?.status === 'active') fail(409, 'already_member');
  await c.env.CENTRAL_DB.prepare(
    `INSERT INTO memberships (org_id, user_id, role, job_title, display_name, status, invite_expires_at, created_at, updated_at) VALUES (?,?,?,?,?, 'invited', ?, ?, ?)
     ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, job_title = excluded.job_title, display_name = excluded.display_name,
       status = 'invited', invite_expires_at = excluded.invite_expires_at, updated_at = excluded.updated_at`,
  ).bind(orgId, user.id, role, body.jobTitle?.trim() ?? '', body.name.trim(), t + INVITE_TTL_MS, t, t).run();
  const org = await c.env.CENTRAL_DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(orgId).first<{ name: string }>();
  await sendSms(c.env, phone, `הוזמנת להצטרף ל-${org?.name} ב-Contexa. התקינו את האפליקציה והתחברו עם מספר הטלפון הזה: https://contexa.app/download`);
  await audit(c.env, auditFrom(c, 'user.invite', 'user', user.id, { role }));
  return c.json({ userId: user.id, status: 'invited', inviteExpiresAt: t + INVITE_TTL_MS }, 201);
});

admin.patch('/users/:userId', async (c) => {
  assertNotManaged(c, 'users');
  const { orgId } = c.get('org');
  const body = await c.req.json<{ role?: 'admin' | 'user'; jobTitle?: string; name?: string }>();
  const target = c.req.param('userId');
  const org = await c.env.CENTRAL_DB.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').bind(orgId).first<{ owner_user_id: string }>();
  if (body.role && body.role !== 'admin' && target === org?.owner_user_id) fail(409, 'cannot_demote_owner');
  const sets: string[] = ['updated_at = ?'];
  const args: unknown[] = [now()];
  if (body.role) (sets.push('role = ?'), args.push(body.role === 'admin' ? 'admin' : 'user'));
  if (body.jobTitle !== undefined) (sets.push('job_title = ?'), args.push(body.jobTitle.trim().slice(0, 60)));
  if (body.name !== undefined) (sets.push('display_name = ?'), args.push(body.name.trim().slice(0, 80)));
  const r = await c.env.CENTRAL_DB.prepare(`UPDATE memberships SET ${sets.join(', ')} WHERE org_id = ? AND user_id = ?`).bind(...args, orgId, target).run();
  if (!r.meta.changes) fail(404, 'member_not_found');
  await audit(c.env, auditFrom(c, 'user.update', 'user', target, { role: body.role, jobTitle: body.jobTitle }));
  return c.json({ ok: true });
});

/** Deactivation removes the user from every group in this org and disconnects all their devices from it (§3.4). */
admin.post('/users/:userId/deactivate', async (c) => {
  assertNotManaged(c, 'users');
  const { orgId } = c.get('org');
  const target = c.req.param('userId');
  const org = await c.env.CENTRAL_DB.prepare('SELECT owner_user_id FROM organizations WHERE id = ?').bind(orgId).first<{ owner_user_id: string }>();
  if (target === org?.owner_user_id) fail(409, 'cannot_deactivate_owner');
  const r = await c.env.CENTRAL_DB.prepare("UPDATE memberships SET status = 'deactivated', updated_at = ? WHERE org_id = ? AND user_id = ? AND status != 'deactivated'").bind(now(), orgId, target).run();
  if (!r.meta.changes) fail(404, 'member_not_found');
  const { results } = await c.env.ORG_DB.prepare('SELECT group_id FROM group_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL').bind(orgId, target).all<{ group_id: string }>();
  await removeFromGroups(c.env, orgId, target, results.map((g) => g.group_id));
  await audit(c.env, auditFrom(c, 'user.deactivate', 'user', target, { groups: results.length }));
  await notifyUsers(c.env, [target], { t: 'wipe', orgId, reason: 'deactivated' });
  return c.json({ ok: true, removedFromGroups: results.length });
});

admin.post('/users/:userId/reactivate', async (c) => {
  assertNotManaged(c, 'users');
  const r = await c.env.CENTRAL_DB.prepare("UPDATE memberships SET status = 'active', updated_at = ? WHERE org_id = ? AND user_id = ? AND status = 'deactivated'")
    .bind(now(), c.get('org').orgId, c.req.param('userId')).run();
  if (!r.meta.changes) fail(404, 'member_not_found');
  await audit(c.env, auditFrom(c, 'user.reactivate', 'user', c.req.param('userId')));
  return c.json({ ok: true });
});

// ---- Context type & document types -------------------------------------------
admin.put('/context-type', async (c) => {
  const body = await c.req.json<{ label: string; labelPlural: string; icon?: string; headerFields?: { key: string; label: string }[] }>();
  if (!body.label?.trim() || !body.labelPlural?.trim()) fail(422, 'invalid_label');
  const fields = (body.headerFields ?? []).filter((f) => /^[\w-]{1,40}$/.test(f.key) && f.label?.trim()).slice(0, 10);
  await c.env.ORG_DB.prepare(
    `INSERT INTO context_types (org_id, label, label_plural, icon, header_fields) VALUES (?,?,?,?,?)
     ON CONFLICT(org_id) DO UPDATE SET label = excluded.label, label_plural = excluded.label_plural, icon = excluded.icon, header_fields = excluded.header_fields`,
  ).bind(c.get('org').orgId, body.label.trim(), body.labelPlural.trim(), body.icon ?? 'person', JSON.stringify(fields)).run();
  await audit(c.env, auditFrom(c, 'settings.context_type'));
  return c.json({ ok: true });
});

admin.get('/doc-types', async (c) => {
  const { results } = await c.env.ORG_DB.prepare('SELECT id, name, sort, active FROM doc_types WHERE org_id = ? ORDER BY sort, name').bind(c.get('org').orgId).all();
  return c.json({ docTypes: results });
});

admin.post('/doc-types', async (c) => {
  const { name, sort } = await c.req.json<{ name: string; sort?: number }>();
  if (!name?.trim()) fail(422, 'invalid_name');
  const id = randomId();
  await c.env.ORG_DB.prepare('INSERT INTO doc_types (id, org_id, name, sort) VALUES (?,?,?,?)').bind(id, c.get('org').orgId, name.trim(), sort ?? 0).run();
  await audit(c.env, auditFrom(c, 'settings.doc_type_create', 'doc_type', id));
  return c.json({ id }, 201);
});

admin.patch('/doc-types/:id', async (c) => {
  const body = await c.req.json<{ name?: string; sort?: number; active?: boolean }>();
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) (sets.push('name = ?'), args.push(body.name.trim()));
  if (body.sort !== undefined) (sets.push('sort = ?'), args.push(body.sort));
  if (body.active !== undefined) (sets.push('active = ?'), args.push(body.active ? 1 : 0));
  if (!sets.length) fail(422, 'nothing_to_update');
  await c.env.ORG_DB.prepare(`UPDATE doc_types SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).bind(...args, c.req.param('id'), c.get('org').orgId).run();
  await audit(c.env, auditFrom(c, 'settings.doc_type_update', 'doc_type', c.req.param('id')));
  return c.json({ ok: true });
});

// ---- Contexts: CSV import ----------------------------------------------------
/** CSV columns: name, display_id, external_id, then header field keys. Optional "members" column: phones separated by ';'. */
admin.post('/contexts/import', async (c) => {
  assertNotManaged(c, 'contexts');
  const { orgId } = c.get('org');
  const rows = parseCsv(await c.req.text());
  if (rows.length < 2) fail(422, 'empty_csv');
  if (rows.length > 5001) fail(413, 'too_many_rows', { max: 5000 });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  if (col('name') < 0) fail(422, 'missing_name_column');
  const memberPhones = new Set<string>();
  rows.slice(1).forEach((r) => (r[col('members')] ?? '').split(';').forEach((p) => p.trim() && memberPhones.add(normalizePhone(p) ?? '')));
  const phoneToUser = new Map<string, string>();
  const phones = [...memberPhones].filter(Boolean);
  for (let i = 0; i < phones.length; i += 90) {
    const chunk = phones.slice(i, i + 90);
    const { results } = await c.env.CENTRAL_DB.prepare(
      `SELECT u.phone, u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ? AND m.status = 'active' WHERE u.phone IN (${chunk.map(() => '?').join(',')})`,
    ).bind(orgId, ...chunk).all<{ phone: string; id: string }>();
    results.forEach((r) => phoneToUser.set(r.phone, r.id));
  }
  const reserved = new Set(['name', 'display_id', 'external_id', 'members']);
  let created = 0;
  const errors: { row: number; error: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[col('name')]?.trim();
    if (!name) {
      errors.push({ row: i + 1, error: 'missing_name' });
      continue;
    }
    const header: Record<string, string> = {};
    head.forEach((h, idx) => !reserved.has(h) && /^[\w-]{1,40}$/.test(h) && r[idx]?.trim() && (header[h] = r[idx].trim().slice(0, 200)));
    const members = (r[col('members')] ?? '').split(';').map((p) => phoneToUser.get(normalizePhone(p.trim()) ?? '')).filter(Boolean) as string[];
    try {
      await createContextWithGroup(c.env, orgId, { name, displayId: r[col('display_id')] ?? '', externalId: r[col('external_id')]?.trim() || null, header, createdBy: c.get('auth').userId, memberIds: members });
      created++;
    } catch {
      errors.push({ row: i + 1, error: 'duplicate_external_id' });
    }
  }
  await audit(c.env, auditFrom(c, 'context.import', undefined, undefined, { created, errors: errors.length }));
  return c.json({ created, errors });
});

// ---- Settings: retention, permissions, operating hours, security -------------
admin.get('/settings', async (c) => c.json(await getSettings(c.env, c.get('org').orgId)));

admin.put('/settings', async (c) => {
  const patch = await c.req.json<Partial<OrgSettings>>();
  const { orgId } = c.get('org');
  const merged = await getSettings(c.env, orgId);
  const candidate = JSON.parse(JSON.stringify(merged)) as OrgSettings;
  Object.assign(candidate, patch, {
    permissions: { ...merged.permissions, ...(patch.permissions ?? {}) },
    operatingHours: { ...merged.operatingHours, ...(patch.operatingHours ?? {}) },
  });
  const bad = validateSettings(candidate);
  if (bad) fail(422, 'invalid_setting', { field: bad });
  const saved = await saveSettings(c.env, orgId, candidate);
  await audit(c.env, auditFrom(c, 'settings.update', undefined, undefined, { keys: Object.keys(patch) }));
  return c.json(saved);
});

// ---- Audit log -------------------------------------------------------------
function auditQuery(c: Context<AppEnv>, limit: number) {
  const where = ['org_id = ?'];
  const args: unknown[] = [c.get('org').orgId];
  const action = c.req.query('action');
  if (action) (where.push('action LIKE ?'), args.push(`${action}%`));
  const userId = c.req.query('userId');
  if (userId) (where.push('actor_user_id = ?'), args.push(userId));
  const from = c.req.query('from');
  if (from) (where.push('at >= ?'), args.push(Number(from)));
  const to = c.req.query('to');
  if (to) (where.push('at <= ?'), args.push(Number(to)));
  const before = c.req.query('before');
  if (before) (where.push('id < ?'), args.push(Number(before)));
  return c.env.ORG_DB.prepare(
    `SELECT id, at, actor_user_id AS actorUserId, actor_device_id AS actorDeviceId, action, target_type AS targetType, target_id AS targetId, meta, ip
       FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).bind(...args, limit).all<{ id: number; at: number; actorUserId: string | null; actorDeviceId: string | null; action: string; targetType: string | null; targetId: string | null; meta: string | null; ip: string | null }>();
}

admin.get('/audit', async (c) => {
  const { results } = await auditQuery(c, Math.min(Number(c.req.query('limit') ?? 100), 500));
  return c.json({ entries: results.map((r) => ({ ...r, meta: parseJson(r.meta, null) })) });
});

admin.get('/audit.csv', async (c) => {
  const { results } = await auditQuery(c, 50_000);
  const names = new Map<string, string>();
  const { results: users } = await c.env.CENTRAL_DB.prepare('SELECT u.id, COALESCE(NULLIF(m.display_name, \'\'), u.name) AS name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?')
    .bind(c.get('org').orgId).all<{ id: string; name: string }>();
  users.forEach((u) => names.set(u.id, u.name));
  await audit(c.env, auditFrom(c, 'audit.export', undefined, undefined, { rows: results.length }));
  const csv = toCsv([
    ['time', 'actor', 'actor_id', 'device', 'action', 'target_type', 'target_id', 'details', 'ip'],
    ...results.map((r) => [new Date(r.at).toISOString(), names.get(r.actorUserId ?? '') ?? '', r.actorUserId, r.actorDeviceId, r.action, r.targetType, r.targetId, r.meta, r.ip]),
  ]);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="contexa-audit.csv"' } });
});

// ---- Devices -----------------------------------------------------------------
admin.get('/devices', async (c) => {
  const { orgId } = c.get('org');
  const { results } = await c.env.CENTRAL_DB.prepare(
    `SELECT d.id, d.user_id AS userId, COALESCE(NULLIF(m.display_name, ''), u.name) AS userName, d.platform, d.name, d.created_at AS createdAt, d.last_seen_at AS lastSeenAt
       FROM devices d JOIN memberships m ON m.user_id = d.user_id AND m.org_id = ? AND m.status = 'active' JOIN users u ON u.id = d.user_id
      WHERE d.revoked_at IS NULL AND d.id NOT IN (SELECT device_id FROM org_device_revocations WHERE org_id = ?)
      ORDER BY d.last_seen_at DESC`,
  ).bind(orgId, orgId).all();
  return c.json({ devices: results });
});

/** Remote disconnect: wipes only this org's data on the device and removes its key wraps (§3.5, §6.5). */
admin.post('/devices/:deviceId/revoke', async (c) => {
  const { orgId } = c.get('org');
  const deviceId = c.req.param('deviceId');
  const dev = await c.env.CENTRAL_DB.prepare(
    "SELECT d.user_id FROM devices d JOIN memberships m ON m.user_id = d.user_id AND m.org_id = ? WHERE d.id = ?",
  ).bind(orgId, deviceId).first<{ user_id: string }>();
  if (!dev) fail(404, 'device_not_found');
  await c.env.CENTRAL_DB.prepare('INSERT OR REPLACE INTO org_device_revocations (org_id, device_id, revoked_by, revoked_at) VALUES (?,?,?,?)')
    .bind(orgId, deviceId, c.get('auth').userId, now()).run();
  await c.env.ORG_DB.batch([
    c.env.ORG_DB.prepare('DELETE FROM group_keys WHERE device_id = ? AND group_id IN (SELECT id FROM groups WHERE org_id = ?)').bind(deviceId, orgId),
    c.env.ORG_DB.prepare('DELETE FROM key_requests WHERE device_id = ? AND group_id IN (SELECT id FROM groups WHERE org_id = ?)').bind(deviceId, orgId),
    auditStmt(c.env, auditFrom(c, 'device.revoke', 'device', deviceId, { userId: dev.user_id })),
  ]);
  await notifyUsers(c.env, [dev.user_id], { t: 'wipe', orgId, reason: 'revoked' });
  return c.json({ ok: true });
});

// ---- Plugins (phase B) -------------------------------------------------------
admin.get('/plugins', (c) => c.json({ plugins: [], available: [], note: 'plugin_platform_phase_b' }));

export default admin;
export { activeOrgUserIds };
