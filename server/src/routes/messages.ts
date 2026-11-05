import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { auditFrom, auditStmt } from '../lib/audit';
import { bumpRevStmt, loadGroup, REV_SUBQUERY } from '../lib/groups';
import { fail, now, parseJson } from '../lib/http';
import { randomId } from '../lib/crypto';
import { pushNewMessage } from '../lib/push';
import { groupMemberIds, notifyUsers } from '../lib/realtime';
import { getSettings } from '../lib/settings';

export const EDIT_WINDOW_MS = 15 * 60_000;
const MAX_CIPHERTEXT = 64 * 1024;

const messages = new Hono<AppEnv>();

interface MessageRow {
  id: string;
  group_id: string;
  seq: number;
  rev: number;
  sender_id: string;
  sender_device_id: string;
  kind: string;
  ciphertext: string | null;
  key_version: number;
  reply_to: string | null;
  file_ids: string | null;
  mentions: string | null;
  client_id: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

async function present(env: Env, rows: MessageRow[]) {
  const ids = rows.map((r) => r.id);
  const archive = new Map<string, unknown[]>();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await env.ORG_DB.prepare(
        `SELECT a.id, a.message_id AS messageId, a.file_id AS fileId, a.doc_type_id AS docTypeId, d.name AS docTypeName, a.saved_by AS savedBy,
                a.saved_at AS savedAt, a.status, a.removed_at AS removedAt, a.external_ref AS externalRef
           FROM archive_docs a LEFT JOIN doc_types d ON d.id = a.doc_type_id WHERE a.message_id IN (${chunk.map(() => '?').join(',')})`,
      ).bind(...chunk).all<{ messageId: string }>();
      for (const a of results) archive.set(a.messageId, [...(archive.get(a.messageId) ?? []), a]);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    seq: r.seq,
    rev: r.rev,
    senderId: r.sender_id,
    senderDeviceId: r.sender_device_id,
    kind: r.kind,
    ciphertext: r.deleted_at ? null : r.ciphertext,
    keyVersion: r.key_version,
    replyTo: r.reply_to,
    fileIds: parseJson<string[]>(r.file_ids, []),
    mentions: parseJson<string[]>(r.mentions, []),
    clientId: r.client_id,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    archive: archive.get(r.id) ?? [],
  }));
}

/** Send an end-to-end encrypted message. The server sees only metadata (§6.5). */
messages.post('/groups/:id/messages', async (c) => {
  const { orgId } = c.get('org');
  const { userId, deviceId } = c.get('auth');
  const { group } = await loadGroup(c, c.req.param('id'), 'write');
  const body = await c.req.json<{ clientId: string; kind: 'text' | 'image' | 'document'; ciphertext: string; keyVersion: number; replyTo?: string; fileIds?: string[]; mentions?: string[] }>();
  if (!/^[\w-]{8,64}$/.test(body.clientId ?? '')) fail(422, 'invalid_client_id');
  if (!['text', 'image', 'document'].includes(body.kind)) fail(422, 'invalid_kind');
  if (typeof body.ciphertext !== 'string' || !body.ciphertext || body.ciphertext.length > MAX_CIPHERTEXT) fail(422, 'invalid_ciphertext');

  const dup = await c.env.ORG_DB.prepare('SELECT * FROM messages WHERE group_id = ? AND client_id = ?').bind(group.id, body.clientId).first<MessageRow>();
  if (dup) return c.json({ message: (await present(c.env, [dup]))[0], duplicate: true });

  if (body.keyVersion < group.min_key_version || body.keyVersion > group.key_version) {
    fail(409, 'key_rotation_required', { keyVersion: group.key_version, minKeyVersion: group.min_key_version });
  }
  const fileIds = [...new Set(body.fileIds ?? [])].slice(0, 10); // up to 10 images at once (§4.3.2)
  if (body.kind !== 'text') {
    const settings = await getSettings(c.env, orgId);
    if (!settings.permissions.sendFiles) fail(403, 'files_not_allowed');
    if (!fileIds.length) fail(422, 'missing_files');
    const { results } = await c.env.ORG_DB.prepare(`SELECT id FROM files WHERE group_id = ? AND uploader_id = ? AND id IN (${fileIds.map(() => '?').join(',')})`)
      .bind(group.id, userId, ...fileIds).all();
    if (results.length !== fileIds.length) fail(422, 'unknown_files');
  }
  if (body.replyTo) {
    const parent = await c.env.ORG_DB.prepare('SELECT 1 AS x FROM messages WHERE id = ? AND group_id = ?').bind(body.replyTo, group.id).first();
    if (!parent) fail(422, 'invalid_reply_to');
  }
  const members = await groupMemberIds(c.env, group.id);
  const mentions = (body.mentions ?? []).filter((m) => members.includes(m)).slice(0, 50);

  const id = randomId();
  const t = now();
  try {
    await c.env.ORG_DB.batch([
      c.env.ORG_DB.prepare('UPDATE groups SET last_seq = last_seq + 1, last_activity_at = ?, last_message_id = ? WHERE id = ?').bind(t, id, group.id),
      bumpRevStmt(c.env, orgId),
      c.env.ORG_DB.prepare(
        `INSERT INTO messages (id, org_id, group_id, seq, rev, sender_id, sender_device_id, kind, ciphertext, key_version, reply_to, file_ids, mentions, client_id, created_at)
         VALUES (?, ?, ?, (SELECT last_seq FROM groups WHERE id = ?), ${REV_SUBQUERY}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, orgId, group.id, group.id, orgId, userId, deviceId, body.kind, body.ciphertext, body.keyVersion, body.replyTo ?? null, fileIds.length ? JSON.stringify(fileIds) : null, mentions.length ? JSON.stringify(mentions) : null, body.clientId, t),
      c.env.ORG_DB.prepare(
        `INSERT INTO group_user_state (group_id, user_id, last_read_seq, last_delivered_seq) VALUES (?, ?, (SELECT last_seq FROM groups WHERE id = ?), (SELECT last_seq FROM groups WHERE id = ?))
         ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, last_delivered_seq = excluded.last_delivered_seq`,
      ).bind(group.id, userId, group.id, group.id),
      auditStmt(c.env, auditFrom(c, 'message.send', 'message', id, { groupId: group.id, kind: body.kind, files: fileIds.length })),
    ]);
  } catch (e) {
    const again = await c.env.ORG_DB.prepare('SELECT * FROM messages WHERE group_id = ? AND client_id = ?').bind(group.id, body.clientId).first<MessageRow>();
    if (again) return c.json({ message: (await present(c.env, [again]))[0], duplicate: true });
    throw e;
  }
  const row = await c.env.ORG_DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>();
  c.executionCtx.waitUntil(
    Promise.all([notifyUsers(c.env, members, { t: 'sync', orgId, groupId: group.id }), pushNewMessage(c.env, orgId, group.id, userId, mentions)]),
  );
  return c.json({ message: (await present(c.env, [row!]))[0] }, 201);
});

/** History page, newest first (chat opens with the last 30–50 messages; scrolling loads more). */
messages.get('/groups/:id/messages', async (c) => {
  const { group } = await loadGroup(c, c.req.param('id'));
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  const { results } = await c.env.ORG_DB.prepare('SELECT * FROM messages WHERE group_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .bind(group.id, before, limit).all<MessageRow>();
  return c.json({ messages: await present(c.env, results), hasMore: results.length === limit });
});

/** Delta sync: "everything new since cursor X" across all of the user's groups in this org (§7.7). */
messages.get('/sync', async (c) => {
  const { orgId } = c.get('org');
  const { userId } = c.get('auth');
  const since = Number(c.req.query('since') ?? 0);
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
  const { results } = await c.env.ORG_DB.prepare(
    `SELECT m.* FROM messages m JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ? AND gm.removed_at IS NULL
      WHERE m.org_id = ? AND m.rev > ? ORDER BY m.rev ASC LIMIT ?`,
  ).bind(userId, orgId, since, limit).all<MessageRow>();
  const head = await c.env.ORG_DB.prepare('SELECT rev FROM org_settings WHERE org_id = ?').bind(orgId).first<{ rev: number }>();
  const hasMore = results.length === limit;
  const cursor = hasMore ? results[results.length - 1].rev : Math.max(head?.rev ?? 0, since);
  return c.json({ messages: await present(c.env, results), cursor, hasMore });
});

/** Who read a message (§4.3.1). */
messages.get('/messages/:id/receipts', async (c) => {
  const m = await c.env.ORG_DB.prepare('SELECT group_id, seq FROM messages WHERE id = ? AND org_id = ?').bind(c.req.param('id'), c.get('org').orgId).first<{ group_id: string; seq: number }>();
  if (!m) fail(404, 'message_not_found');
  await loadGroup(c, m.group_id);
  const { results } = await c.env.ORG_DB.prepare(
    `SELECT gm.user_id AS userId, COALESCE(s.last_read_seq, 0) >= ? AS read, COALESCE(s.last_delivered_seq, 0) >= ? AS delivered
       FROM group_members gm LEFT JOIN group_user_state s ON s.group_id = gm.group_id AND s.user_id = gm.user_id
      WHERE gm.group_id = ? AND gm.removed_at IS NULL`,
  ).bind(m.seq, m.seq, m.group_id).all();
  return c.json({ receipts: results });
});

async function loadOwnMessage(c: Context<AppEnv>, id: string) {
  const m = await c.env.ORG_DB.prepare('SELECT * FROM messages WHERE id = ? AND org_id = ?').bind(id, c.get('org').orgId).first<MessageRow>();
  if (!m) fail(404, 'message_not_found');
  await loadGroup(c, m.group_id, 'write');
  if (m.sender_id !== c.get('auth').userId) fail(403, 'not_sender');
  if (m.deleted_at) fail(410, 'message_deleted');
  if (now() - m.created_at > EDIT_WINDOW_MS) fail(403, 'edit_window_passed');
  return m;
}

/** Edit by the sender within 15 minutes (§4.3.1). */
messages.put('/messages/:id', async (c) => {
  const m = await loadOwnMessage(c, c.req.param('id'));
  const { ciphertext, keyVersion } = await c.req.json<{ ciphertext: string; keyVersion: number }>();
  if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > MAX_CIPHERTEXT) fail(422, 'invalid_ciphertext');
  const orgId = c.get('org').orgId;
  await c.env.ORG_DB.batch([
    bumpRevStmt(c.env, orgId),
    c.env.ORG_DB.prepare(`UPDATE messages SET ciphertext = ?, key_version = ?, edited_at = ?, rev = ${REV_SUBQUERY} WHERE id = ?`).bind(ciphertext, keyVersion, now(), orgId, m.id),
    auditStmt(c.env, auditFrom(c, 'message.edit', 'message', m.id, { groupId: m.group_id })),
  ]);
  await notifyUsers(c.env, await groupMemberIds(c.env, m.group_id), { t: 'sync', orgId, groupId: m.group_id });
  return c.json({ ok: true });
});

/** Delete by the sender within 15 minutes; leaves a "message deleted" marker and an audit entry. The archive copy is kept. */
messages.delete('/messages/:id', async (c) => {
  const orgId = c.get('org').orgId;
  const settings = await getSettings(c.env, orgId);
  if (!settings.permissions.deleteMessages) fail(403, 'delete_not_allowed');
  const m = await loadOwnMessage(c, c.req.param('id'));
  await c.env.ORG_DB.batch([
    bumpRevStmt(c.env, orgId),
    c.env.ORG_DB.prepare(`UPDATE messages SET ciphertext = NULL, deleted_at = ?, rev = ${REV_SUBQUERY} WHERE id = ?`).bind(now(), orgId, m.id),
    auditStmt(c.env, auditFrom(c, 'message.delete', 'message', m.id, { groupId: m.group_id, kind: m.kind })),
  ]);
  await notifyUsers(c.env, await groupMemberIds(c.env, m.group_id), { t: 'sync', orgId, groupId: m.group_id });
  return c.json({ ok: true });
});

export { present as presentMessages };
export type { MessageRow };
export default messages;
