/**
 * Media pipeline (§4.3.2, §7.7): images are resized on the device into three variants (thumb ~15KB WebP,
 * preview ~150KB, original compressed unless "original quality"), each encrypted with a per-file key and
 * uploaded through short-lived signed URLs. Downloaded media is cached encrypted in the app sandbox.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { api, ApiError } from '../api/client';
import { decryptBytes, encryptBytes, fromB64, generateSymmetricKey, toB64, type MessagePayload } from '../crypto/e2e';
import type { LocalDb } from '../db/local';
import { MAX_FILE_BYTES } from '../config';

type Variant = 'thumb' | 'preview' | 'original';
type FileMeta = NonNullable<MessagePayload['files']>[number];

async function readBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

async function render(uri: string, width: number | null, compress: number, format: ImageManipulator.SaveFormat) {
  const r = await ImageManipulator.manipulateAsync(uri, width ? [{ resize: { width } }] : [], { compress, format });
  const bytes = await readBytes(r.uri);
  new File(r.uri).delete();
  return { bytes, width: r.width, height: r.height };
}

export async function prepareImage(uri: string, name: string, originalQuality: boolean) {
  const thumb = await render(uri, 240, 0.5, ImageManipulator.SaveFormat.WEBP);
  const preview = await render(uri, 1280, 0.7, ImageManipulator.SaveFormat.JPEG);
  const original = originalQuality ? { ...(await render(uri, null, 1, ImageManipulator.SaveFormat.JPEG)) } : await render(uri, 2560, 0.8, ImageManipulator.SaveFormat.JPEG);
  if (original.bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'file_too_large');
  return {
    kind: 'image' as const,
    variants: { thumb: thumb.bytes, preview: preview.bytes, original: original.bytes } as Record<Variant, Uint8Array>,
    meta: { name, mime: 'image/jpeg', size: original.bytes.length, width: original.width, height: original.height },
  };
}

export async function prepareDocument(uri: string, name: string, mime: string, size: number) {
  if (size > MAX_FILE_BYTES) throw new ApiError(413, 'file_too_large');
  const bytes = await readBytes(uri);
  if (bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'file_too_large');
  return { kind: 'document' as const, variants: { original: bytes } as Partial<Record<Variant, Uint8Array>>, meta: { name, mime, size: bytes.length } };
}

/** Encrypts every variant with one fresh file key and uploads the ciphertext. */
export async function uploadPrepared(groupId: string, prepared: Awaited<ReturnType<typeof prepareImage>> | Awaited<ReturnType<typeof prepareDocument>>): Promise<FileMeta> {
  const fileKey = generateSymmetricKey();
  const encrypted = Object.entries(prepared.variants).map(([name, bytes]) => ({ name: name as Variant, data: encryptBytes(fileKey, bytes!) }));
  const r = await api.post<{ fileId: string; uploads: Record<string, string> }>('/v1/files', {
    groupId, kind: prepared.kind, variants: encrypted.map((v) => ({ name: v.name, size: v.data.length })),
  });
  for (const v of encrypted) {
    const res = await fetch(r.uploads[v.name], { method: 'PUT', body: v.data as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
    if (!res.ok) throw new ApiError(res.status, 'upload_failed');
  }
  return { id: r.fileId, key: toB64(fileKey), ...prepared.meta };
}

function mediaDir(orgId: string): Directory {
  const d = new Directory(Paths.document, 'media', orgId);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

/** Returns decrypted bytes of a variant, using the encrypted on-device cache when possible. */
export async function loadMedia(db: LocalDb, file: FileMeta, variant: Variant, quotaMb = 500): Promise<Uint8Array> {
  const cacheKey = `${file.id}:${variant}`;
  const cached = await db.mediaGet(cacheKey);
  let encrypted: Uint8Array | null = null;
  if (cached) {
    const f = new File(cached);
    if (f.exists) encrypted = await f.bytes();
  }
  if (!encrypted) {
    const { url } = await api.get<{ url: string }>(`/v1/files/${file.id}/${variant}`);
    const res = await fetch(url);
    if (!res.ok) throw new ApiError(res.status, 'download_failed');
    encrypted = new Uint8Array(await res.arrayBuffer());
    const out = new File(mediaDir(db.orgId), `${file.id}-${variant}.bin`);
    if (out.exists) out.delete();
    out.create();
    out.write(encrypted);
    await db.mediaPut(cacheKey, out.uri, encrypted.length);
    for (const p of await db.mediaEvict(quotaMb * 1024 * 1024)) {
      const f = new File(p);
      if (f.exists) f.delete();
    }
  }
  return decryptBytes(fromB64(file.key), encrypted);
}

export function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toB64(bytes)}`;
}

/** Temporary plaintext copy for "share outside the app" — only when the org allows it; deleted after use. */
export async function withTempPlainFile<T>(name: string, bytes: Uint8Array, fn: (uri: string) => Promise<T>): Promise<T> {
  const f = new File(Paths.cache, `share-${Date.now()}-${name.replace(/[^\w.\-֐-׿ ]/g, '_')}`);
  f.create();
  f.write(bytes);
  try {
    return await fn(f.uri);
  } finally {
    if (f.exists) f.delete();
  }
}

export function wipeOrgMedia(orgId: string) {
  const d = new Directory(Paths.document, 'media', orgId);
  if (d.exists) d.delete();
}

export function wipeAllMedia() {
  const d = new Directory(Paths.document, 'media');
  if (d.exists) d.delete();
}
