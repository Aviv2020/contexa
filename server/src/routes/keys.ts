import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { loadGroup } from '../lib/groups';
import { fail, now } from '../lib/http';
import { groupMemberIds, notifyUsers, orgAdminIds } from '../lib/realtime';

/**
 * Group key distribution (§6.5). Clients generate group keys and wrap them per device with the device's
 * X25519 public key; the server stores wraps only and never sees a key.
 */
const keys = new Hono<AppEnv>();

/** Devices entitled to a group's key: active devices of group members and org admins, plus the org recovery key. */
async function eligibleDevices(env: Env, orgId: string, groupId: string) {
  const userIds = [...new Set([...(await groupMemberIds(env, groupId)), ...(await orgAdminIds(env, orgId))])];
  if (!userIds.length) return [];
  const { results } = await env.CENTRAL_DB.prepare(
    `SELECT d.id AS deviceId, d.user_id AS userId, d.public_key AS publicKey FROM devices d
      WHERE d.revoked_at IS NULL AND d.user_id IN (${userIds.map(() => '?').join(',')})
        AND d.id NOT IN (SELECT device_id FROM org_device_revocations WHERE org_id = ?)`,
  ).bind(...userIds, orgId).all<{ deviceId: string; userId: string; publicKey: string }>();
  return results;
}

keys.get('/groups/:id/keys', async (c) => {
  const { group } = await loadGroup(c, c.req.param('id'));
  const { results } = await c.env.ORG_DB.prepare(
    'SELECT version, wrapped_key AS wrappedKey, wrapped_by_device AS wrappedByDevice FROM group_keys WHERE group_id = ? AND device_id = ? ORDER BY version',
  ).bind(group.id, c.get('auth').deviceId).all<{ version: number }>();
  return c.json({ keyVersion: group.key_version, minKeyVersion: group.min_key_version, wraps: results });
});

keys.get('/groups/:id/key-recipients', async (c) => {
  const { orgId } = c.get('org');
  const { group } = await loadGroup(c, c.req.param('id'));
  const org = await c.env.CENTRAL_DB.prepare('SELECT recovery_public_key AS k FROM organizations WHERE id = ?').bind(orgId).first<{ k: string | null }>();
  return c.json({ keyVersion: group.key_version, minKeyVersion: group.min_key_version, devices: await eligibleDevices(c.env, orgId, group.id), recoveryPublicKey: org?.k ?? null });
});

/**
 * Upload wraps. version === keyVersion + 1 creates a new key version (first sender, or rotation after a removal);
 * a version <= keyVersion adds wraps for devices that are missing them (new member, new device).
 */
keys.post('/groups/:id/keys', async (c) => {
  const { orgId } = c.get('org');
  const { deviceId } = c.get('auth');
  const { group, isMember } = await loadGroup(c, c.req.param('id'));
  const body = await c.req.json<{ version: number; wraps: { deviceId: string; wrappedKey: string }[] }>();
  if (!Number.isInteger(body.version) || body.version < 1) fail(422, 'invalid_version');
  if (!Array.isArray(body.wraps) || !body.wraps.length || body.wraps.length > 2000) fail(422, 'invalid_wraps');

  const eligible = await eligibleDevices(c.env, orgId, group.id);
  const allowed = new Set([...eligible.map((d) => d.deviceId), 'recovery']);
  const wraps = body.wraps.filter((w) => allowed.has(w.deviceId) && typeof w.wrappedKey === 'string' && w.wrappedKey.length < 512);
  const t = now();

  if (body.version === group.key_version + 1) {
    if (!isMember) fail(403, 'not_a_group_member');
    if (!wraps.some((w) => w.deviceId === deviceId)) fail(422, 'missing_own_wrap');
    const r = await c.env.ORG_DB.prepare('UPDATE groups SET key_version = ? WHERE id = ? AND key_version = ?').bind(body.version, group.id, group.key_version).run();
    if (!r.meta.changes) fail(409, 'key_version_conflict');
  } else if (body.version > group.key_version) {
    fail(409, 'key_version_conflict', { keyVersion: group.key_version });
  } else {
    // Adding wraps to an existing version: the uploader must hold that version itself.
    const holds = await c.env.ORG_DB.prepare('SELECT 1 AS x FROM group_keys WHERE group_id = ? AND version = ? AND device_id = ?').bind(group.id, body.version, deviceId).first();
    if (!holds) fail(403, 'key_not_held');
  }

  const stmts = wraps.map((w) =>
    c.env.ORG_DB.prepare('INSERT OR IGNORE INTO group_keys (group_id, version, device_id, wrapped_key, wrapped_by_device, created_at) VALUES (?,?,?,?,?,?)')
      .bind(group.id, body.version, w.deviceId, w.wrappedKey, deviceId, t),
  );
  for (let i = 0; i < stmts.length; i += 90) await c.env.ORG_DB.batch(stmts.slice(i, i + 90));

  // Recompute outstanding requests: an eligible device is satisfied once it holds every version up to the latest.
  const latest = Math.max(group.key_version, body.version);
  const { results: held } = await c.env.ORG_DB.prepare('SELECT device_id, COUNT(*) AS n FROM group_keys WHERE group_id = ? GROUP BY device_id').bind(group.id).all<{ device_id: string; n: number }>();
  const counts = new Map(held.map((h) => [h.device_id, h.n]));
  const reqStmts: D1PreparedStatement[] = [];
  for (const d of eligible) {
    if ((counts.get(d.deviceId) ?? 0) >= latest) reqStmts.push(c.env.ORG_DB.prepare('DELETE FROM key_requests WHERE group_id = ? AND device_id = ?').bind(group.id, d.deviceId));
    else reqStmts.push(c.env.ORG_DB.prepare('INSERT OR IGNORE INTO key_requests (group_id, device_id, created_at) VALUES (?,?,?)').bind(group.id, d.deviceId, t));
  }
  for (let i = 0; i < reqStmts.length; i += 90) await c.env.ORG_DB.batch(reqStmts.slice(i, i + 90));

  const notifyIds = [...new Set(eligible.map((d) => d.userId))];
  await notifyUsers(c.env, notifyIds, { t: 'keys', orgId, groupId: group.id });
  return c.json({ ok: true, stored: wraps.length, keyVersion: latest });
});

/** A device without the key (e.g. an admin opening a group, a re-keyed device) asks the online members for it. */
keys.post('/groups/:id/keys/request', async (c) => {
  const { orgId } = c.get('org');
  const { group } = await loadGroup(c, c.req.param('id'));
  await c.env.ORG_DB.prepare('INSERT OR IGNORE INTO key_requests (group_id, device_id, created_at) VALUES (?,?,?)').bind(group.id, c.get('auth').deviceId, now()).run();
  await notifyUsers(c.env, await groupMemberIds(c.env, group.id), { t: 'keys', orgId, groupId: group.id });
  return c.json({ ok: true });
});

/** Outstanding requests this device can fulfil: groups where it holds key versions that other devices lack. */
keys.get('/keys/requests', async (c) => {
  const { orgId } = c.get('org');
  const { deviceId } = c.get('auth');
  const { results } = await c.env.ORG_DB.prepare(
    `SELECT kr.group_id AS groupId, kr.device_id AS deviceId FROM key_requests kr JOIN groups g ON g.id = kr.group_id
      WHERE g.org_id = ? AND kr.device_id != ? AND EXISTS (SELECT 1 FROM group_keys k WHERE k.group_id = kr.group_id AND k.device_id = ?)
      ORDER BY kr.created_at LIMIT 100`,
  ).bind(orgId, deviceId, deviceId).all<{ groupId: string; deviceId: string }>();
  if (!results.length) return c.json({ requests: [] });
  const devIds = [...new Set(results.map((r) => r.deviceId))];
  const { results: devs } = await c.env.CENTRAL_DB.prepare(`SELECT id, public_key FROM devices WHERE revoked_at IS NULL AND id IN (${devIds.map(() => '?').join(',')})`)
    .bind(...devIds).all<{ id: string; public_key: string }>();
  const pk = new Map(devs.map((d) => [d.id, d.public_key]));
  const out = [];
  for (const r of results) {
    if (!pk.has(r.deviceId)) continue;
    const { results: have } = await c.env.ORG_DB.prepare('SELECT version FROM group_keys WHERE group_id = ? AND device_id = ?').bind(r.groupId, r.deviceId).all<{ version: number }>();
    const { results: mine } = await c.env.ORG_DB.prepare('SELECT version FROM group_keys WHERE group_id = ? AND device_id = ?').bind(r.groupId, deviceId).all<{ version: number }>();
    const haveSet = new Set(have.map((h) => h.version));
    const versions = mine.map((m) => m.version).filter((v) => !haveSet.has(v));
    if (versions.length) out.push({ ...r, publicKey: pk.get(r.deviceId), versions });
  }
  return c.json({ requests: out });
});

export default keys;
