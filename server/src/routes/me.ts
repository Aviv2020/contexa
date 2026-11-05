import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { listOrgs } from './auth';
import { fail, now } from '../lib/http';
import { randomId } from '../lib/crypto';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { audit } from '../lib/audit';

const me = new Hono<AppEnv>();

me.get('/', async (c) => {
  const { userId } = c.get('auth');
  const user = await c.env.CENTRAL_DB.prepare('SELECT id, phone, name, locale FROM users WHERE id = ?').bind(userId).first();
  const orgs = await listOrgs(c.env, userId);
  // Unread count per org for the org switcher (§3.5).
  const withUnread = await Promise.all(
    orgs.map(async (o) => {
      const r = await c.env.ORG_DB.prepare(
        `SELECT COALESCE(SUM(g.last_seq - COALESCE(s.last_read_seq, 0)), 0) AS unread
           FROM group_members gm JOIN groups g ON g.id = gm.group_id
           LEFT JOIN group_user_state s ON s.group_id = gm.group_id AND s.user_id = gm.user_id
          WHERE gm.org_id = ? AND gm.user_id = ? AND gm.removed_at IS NULL`,
      ).bind(o.id, userId).first<{ unread: number }>();
      return { ...o, unread: r?.unread ?? 0 };
    }),
  );
  const sys = await c.env.CENTRAL_DB.prepare('SELECT 1 AS x FROM system_admins WHERE user_id = ?').bind(userId).first();
  return c.json({ user, orgs: withUnread, isSystemAdmin: !!sys });
});

me.put('/', async (c) => {
  const body = await c.req.json<{ name?: string; locale?: 'he' | 'en' }>();
  const { userId } = c.get('auth');
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 80) fail(422, 'invalid_name');
    await c.env.CENTRAL_DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, userId).run();
  }
  if (body.locale) {
    if (!['he', 'en'].includes(body.locale)) fail(422, 'invalid_locale');
    await c.env.CENTRAL_DB.prepare('UPDATE users SET locale = ? WHERE id = ?').bind(body.locale, userId).run();
  }
  return c.json({ ok: true });
});

me.put('/device', async (c) => {
  const body = await c.req.json<{ pushToken?: string | null }>();
  await c.env.CENTRAL_DB.prepare('UPDATE devices SET push_token = ?, last_seen_at = ? WHERE id = ?').bind(body.pushToken ?? null, now(), c.get('auth').deviceId).run();
  return c.json({ ok: true });
});

/** Public keys of devices, used by clients to wrap group keys. */
me.get('/device-keys', async (c) => {
  const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 200);
  if (!ids.length) return c.json({ devices: [] });
  const { results } = await c.env.CENTRAL_DB.prepare(
    `SELECT id, user_id AS userId, public_key AS publicKey FROM devices WHERE revoked_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all();
  return c.json({ devices: results });
});

/** Create a standalone organisation; the creator becomes its owner and first admin (§3.2). */
me.post('/orgs', async (c) => {
  const body = await c.req.json<{ name: string; contextLabel: string; contextLabelPlural: string; recoveryPublicKey: string; displayName?: string; jobTitle?: string }>();
  const name = body.name?.trim();
  if (!name || name.length > 100) fail(422, 'invalid_name');
  if (!body.contextLabel?.trim() || !body.contextLabelPlural?.trim()) fail(422, 'invalid_context_label');
  if (!body.recoveryPublicKey) fail(422, 'missing_recovery_key');
  const { userId } = c.get('auth');
  const orgId = randomId();
  const t = now();
  const user = await c.env.CENTRAL_DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
  await c.env.CENTRAL_DB.batch([
    c.env.CENTRAL_DB.prepare('INSERT INTO organizations (id, name, owner_user_id, recovery_public_key, created_at) VALUES (?,?,?,?,?)').bind(orgId, name, userId, body.recoveryPublicKey, t),
    c.env.CENTRAL_DB.prepare("INSERT INTO memberships (org_id, user_id, role, job_title, display_name, status, created_at, updated_at) VALUES (?,?, 'admin', ?, ?, 'active', ?, ?)")
      .bind(orgId, userId, body.jobTitle?.trim() ?? '', body.displayName?.trim() || user?.name || '', t, t),
  ]);
  const docTypes = ['תמונה', 'מסמך', 'הפניה', 'סיכום'];
  await c.env.ORG_DB.batch([
    c.env.ORG_DB.prepare('INSERT INTO org_settings (org_id, settings) VALUES (?, ?)').bind(orgId, JSON.stringify(DEFAULT_SETTINGS)),
    c.env.ORG_DB.prepare('INSERT INTO context_types (org_id, label, label_plural) VALUES (?,?,?)').bind(orgId, body.contextLabel.trim(), body.contextLabelPlural.trim()),
    ...docTypes.map((d, i) => c.env.ORG_DB.prepare('INSERT INTO doc_types (id, org_id, name, sort) VALUES (?,?,?,?)').bind(randomId(), orgId, d, i)),
  ]);
  await audit(c.env, { orgId, actorUserId: userId, actorDeviceId: c.get('auth').deviceId, action: 'org.create', targetType: 'org', targetId: orgId });
  return c.json({ id: orgId, name, mode: 'standalone', role: 'admin' }, 201);
});

export default me;
