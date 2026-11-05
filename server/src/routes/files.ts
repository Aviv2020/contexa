import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { auditFrom, auditStmt } from '../lib/audit';
import { randomId, signBlobToken, verifyBlobToken } from '../lib/crypto';
import { loadGroup } from '../lib/groups';
import { fail, now, parseJson } from '../lib/http';
import { getSettings } from '../lib/settings';

/**
 * Files are encrypted on the device (per-file AES-256-GCM key, carried inside the encrypted message)
 * and uploaded in three variants produced on the device: thumb, preview, original (§7.7).
 * The server never processes or reads them; access is through short-lived signed URLs.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ENCRYPTION_OVERHEAD = 1024;
const VARIANTS = ['thumb', 'preview', 'original'] as const;
type Variant = (typeof VARIANTS)[number];
const VARIANT_LIMIT: Record<Variant, number> = { thumb: 256 * 1024, preview: 2 * 1024 * 1024, original: MAX_FILE_BYTES + ENCRYPTION_OVERHEAD };

const files = new Hono<AppEnv>();

const r2Key = (orgId: string, fileId: string, v: Variant) => `${orgId}/${fileId}/${v}`;

files.post('/files', async (c) => {
  const { orgId } = c.get('org');
  const body = await c.req.json<{ groupId: string; kind: 'image' | 'document'; variants: { name: Variant; size: number }[] }>();
  const { group } = await loadGroup(c, body.groupId, 'write');
  const settings = await getSettings(c.env, orgId);
  if (!settings.permissions.sendFiles) fail(403, 'files_not_allowed');
  if (!['image', 'document'].includes(body.kind)) fail(422, 'invalid_kind');
  const variants = body.variants ?? [];
  if (!variants.some((v) => v.name === 'original')) fail(422, 'missing_original');
  for (const v of variants) {
    if (!VARIANTS.includes(v.name)) fail(422, 'invalid_variant');
    if (!Number.isInteger(v.size) || v.size <= 0 || v.size > VARIANT_LIMIT[v.name]) fail(413, 'file_too_large', { maxBytes: MAX_FILE_BYTES });
  }
  const id = randomId();
  const original = variants.find((v) => v.name === 'original')!;
  await c.env.ORG_DB.prepare('INSERT INTO files (id, org_id, group_id, uploader_id, kind, size, variants, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, orgId, group.id, c.get('auth').userId, body.kind, original.size, JSON.stringify(variants.map((v) => v.name)), now()).run();
  const base = new URL(c.req.url).origin;
  const uploads: Record<string, string> = {};
  for (const v of variants) uploads[v.name] = `${base}/v1/blob/${await signBlobToken(c.env.BLOB_URL_SECRET, r2Key(orgId, id, v.name), 'PUT', 600, v.size)}`;
  return c.json({ fileId: id, uploads }, 201);
});

/** Returns a short-lived download URL for one variant. Downloading originals is logged ("who viewed"). */
files.get('/files/:id/:variant', async (c) => {
  const { orgId } = c.get('org');
  const variant = c.req.param('variant') as Variant;
  if (!VARIANTS.includes(variant)) fail(422, 'invalid_variant');
  const f = await c.env.ORG_DB.prepare('SELECT id, group_id, variants, purged_at FROM files WHERE id = ? AND org_id = ?').bind(c.req.param('id'), orgId).first<{ id: string; group_id: string; variants: string; purged_at: number | null }>();
  if (!f) fail(404, 'file_not_found');
  await loadGroup(c, f.group_id);
  if (f.purged_at) fail(410, 'file_purged');
  if (!parseJson<string[]>(f.variants, []).includes(variant)) fail(404, 'variant_not_found');
  if (variant === 'original') await c.env.ORG_DB.batch([auditStmt(c.env, auditFrom(c, 'file.view', 'file', f.id, { groupId: f.group_id }))]);
  const url = `${new URL(c.req.url).origin}/v1/blob/${await signBlobToken(c.env.BLOB_URL_SECRET, r2Key(orgId, f.id, variant), 'GET', 300)}`;
  return c.json({ url, expiresInSec: 300 });
});

/** Signed blob endpoints (no session auth: the token is the capability). Bytes are ciphertext only. */
export const blob = new Hono<AppEnv>();

blob.put('/:token', async (c) => {
  const t = await verifyBlobToken(c.env.BLOB_URL_SECRET, c.req.param('token'), 'PUT');
  if (!t) fail(403, 'invalid_blob_token');
  const len = Number(c.req.header('content-length') ?? 0);
  if (!len || len > t.maxBytes) fail(413, 'size_mismatch');
  if (await c.env.FILES.head(t.key)) fail(409, 'already_uploaded');
  // Files above Workers' request limit would need R2 multipart upload; 25MB fits in a single PUT.
  await c.env.FILES.put(t.key, c.req.raw.body!, { httpMetadata: { contentType: 'application/octet-stream' } });
  return c.json({ ok: true });
});

blob.get('/:token', async (c) => {
  const t = await verifyBlobToken(c.env.BLOB_URL_SECRET, c.req.param('token'), 'GET');
  if (!t) fail(403, 'invalid_blob_token');
  const obj = await c.env.FILES.get(t.key);
  if (!obj) fail(404, 'not_found');
  return new Response(obj.body, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag },
  });
});

export default files;
