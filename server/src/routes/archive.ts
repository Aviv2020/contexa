import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { auditFrom, auditStmt } from '../lib/audit';
import { randomId } from '../lib/crypto';
import { bumpRevStmt, loadGroup, REV_SUBQUERY } from '../lib/groups';
import { fail, now, parseJson } from '../lib/http';
import { groupMemberIds, notifyUsers } from '../lib/realtime';
import { getSettings } from '../lib/settings';
import { assertNotManaged } from '../middleware';

/** Save to the context archive (§4.3.3). In standalone mode the file stays encrypted, as in the chat. */
const archive = new Hono<AppEnv>();

archive.post('/groups/:id/archive', async (c) => {
  const { orgId, role, mode } = c.get('org');
  const { userId } = c.get('auth');
  const { group } = await loadGroup(c, c.req.param('id'), 'write');
  const settings = await getSettings(c.env, orgId);
  if (settings.permissions.archiveSave === 'admins' && role !== 'admin') fail(403, 'archive_not_allowed');
  if (mode === 'connected') fail(501, 'plugin_archive_not_available_in_phase_a');

  const body = await c.req.json<{ messageId: string; fileIds: string[]; docTypeId: string; descriptionCt?: string; keyVersion?: number; docDate: string }>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.docDate ?? '')) fail(422, 'invalid_doc_date');
  if (body.descriptionCt && body.descriptionCt.length > 8192) fail(422, 'description_too_long');
  const docType = await c.env.ORG_DB.prepare('SELECT id FROM doc_types WHERE id = ? AND org_id = ? AND active = 1').bind(body.docTypeId, orgId).first();
  if (!docType) fail(422, 'invalid_doc_type');
  const msg = await c.env.ORG_DB.prepare('SELECT id, file_ids FROM messages WHERE id = ? AND group_id = ?').bind(body.messageId, group.id).first<{ id: string; file_ids: string | null }>();
  if (!msg) fail(404, 'message_not_found');
  const msgFiles = parseJson<string[]>(msg.file_ids, []);
  const fileIds = [...new Set(body.fileIds ?? [])];
  if (!fileIds.length || !fileIds.every((f) => msgFiles.includes(f))) fail(422, 'invalid_files');

  // A file can be saved once; a repeat attempt returns the existing save (§4.3.3).
  const { results: existing } = await c.env.ORG_DB.prepare(
    `SELECT a.id, a.file_id AS fileId, a.saved_by AS savedBy, a.saved_at AS savedAt, d.name AS docTypeName FROM archive_docs a LEFT JOIN doc_types d ON d.id = a.doc_type_id
      WHERE a.file_id IN (${fileIds.map(() => '?').join(',')}) AND a.removed_at IS NULL`,
  ).bind(...fileIds).all();
  if (existing.length) fail(409, 'already_saved', { existing });

  const t = now();
  const ids: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const f of fileIds) {
    const id = randomId();
    ids.push(id);
    stmts.push(
      c.env.ORG_DB.prepare('DELETE FROM archive_docs WHERE file_id = ? AND removed_at IS NOT NULL').bind(f),
      c.env.ORG_DB.prepare(
        'INSERT INTO archive_docs (id, org_id, context_id, file_id, message_id, doc_type_id, description_ct, key_version, doc_date, saved_by, saved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(id, orgId, group.context_id, f, msg.id, body.docTypeId, body.descriptionCt ?? null, body.keyVersion ?? null, body.docDate, userId, t),
    );
  }
  stmts.push(
    bumpRevStmt(c.env, orgId),
    c.env.ORG_DB.prepare(`UPDATE messages SET rev = ${REV_SUBQUERY} WHERE id = ?`).bind(orgId, msg.id),
    auditStmt(c.env, auditFrom(c, 'archive.save', 'message', msg.id, { contextId: group.context_id, files: fileIds.length, docTypeId: body.docTypeId })),
  );
  await c.env.ORG_DB.batch(stmts);
  await notifyUsers(c.env, await groupMemberIds(c.env, group.id), { t: 'sync', orgId, groupId: group.id });
  return c.json({ saved: ids, savedAt: t, savedBy: userId }, 201);
});

/** Archive listing, accessible from the group header, filterable by doc type and date range. */
archive.get('/contexts/:id/archive', async (c) => {
  const { orgId } = c.get('org');
  const g = await c.env.ORG_DB.prepare('SELECT id FROM groups WHERE context_id = ? AND org_id = ?').bind(c.req.param('id'), orgId).first<{ id: string }>();
  if (!g) fail(404, 'context_not_found');
  await loadGroup(c, g.id);
  const where = ['a.context_id = ?', 'a.removed_at IS NULL'];
  const args: unknown[] = [c.req.param('id')];
  const docType = c.req.query('docTypeId');
  if (docType) (where.push('a.doc_type_id = ?'), args.push(docType));
  const from = c.req.query('from');
  if (from) (where.push('a.doc_date >= ?'), args.push(from));
  const to = c.req.query('to');
  if (to) (where.push('a.doc_date <= ?'), args.push(to));
  const { results } = await c.env.ORG_DB.prepare(
    `SELECT a.id, a.file_id AS fileId, a.message_id AS messageId, a.doc_type_id AS docTypeId, d.name AS docTypeName, a.description_ct AS descriptionCt,
            a.key_version AS keyVersion, a.doc_date AS docDate, a.saved_by AS savedBy, a.saved_at AS savedAt, f.kind, f.size, m.ciphertext AS messageCiphertext,
            m.key_version AS messageKeyVersion
       FROM archive_docs a LEFT JOIN doc_types d ON d.id = a.doc_type_id JOIN files f ON f.id = a.file_id LEFT JOIN messages m ON m.id = a.message_id
      WHERE ${where.join(' AND ')} ORDER BY a.doc_date DESC, a.saved_at DESC LIMIT 500`,
  ).bind(...args).all();
  return c.json({ groupId: g.id, documents: results });
});

/** Standalone only: an admin may remove a document from the archive; it is logged. */
archive.delete('/archive/:id', async (c) => {
  const { orgId, role } = c.get('org');
  if (role !== 'admin') fail(403, 'admin_only');
  assertNotManaged(c, 'archive');
  const doc = await c.env.ORG_DB.prepare('SELECT id, message_id, context_id FROM archive_docs WHERE id = ? AND org_id = ? AND removed_at IS NULL').bind(c.req.param('id'), orgId).first<{ id: string; message_id: string; context_id: string }>();
  if (!doc) fail(404, 'not_found');
  await c.env.ORG_DB.batch([
    c.env.ORG_DB.prepare("UPDATE archive_docs SET removed_at = ?, removed_by = ?, status = 'removed' WHERE id = ?").bind(now(), c.get('auth').userId, doc.id),
    bumpRevStmt(c.env, orgId),
    c.env.ORG_DB.prepare(`UPDATE messages SET rev = ${REV_SUBQUERY} WHERE id = ?`).bind(orgId, doc.message_id),
    auditStmt(c.env, auditFrom(c, 'archive.remove', 'archive_doc', doc.id, { contextId: doc.context_id })),
  ]);
  return c.json({ ok: true });
});

export default archive;
