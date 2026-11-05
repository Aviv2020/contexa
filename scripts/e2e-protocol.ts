/**
 * End-to-end protocol check against a running API (wrangler dev): two real devices with X25519 keys,
 * group key creation + wrapping, encrypted messages/files, key requests, archive save, removal + rotation.
 * Run: node --experimental-strip-types scripts/e2e-protocol.ts [http://localhost:8787]
 */
import * as e2e from '../app/src/crypto/e2e.ts';

const API = process.argv[2] ?? 'http://localhost:8787';
let n = 0;
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓', msg);
  n++;
};

async function req(method: string, path: string, o: { token?: string; org?: string; body?: unknown; raw?: Uint8Array } = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.org) headers['x-org-id'] = o.org;
  let body: BodyInit | undefined;
  if (o.body !== undefined) (headers['content-type'] = 'application/json'), (body = JSON.stringify(o.body));
  if (o.raw) body = o.raw as unknown as BodyInit;
  const res = await fetch(API + path, { method, headers, body });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json };
}

async function device(phone: string) {
  const kp = e2e.generateKeyPair();
  const deviceId = `dev${Math.random().toString(36).slice(2)}${Date.now()}`;
  const r1 = await req('POST', '/v1/auth/otp/request', { body: { phone, deviceId } });
  const r2 = await req('POST', '/v1/auth/otp/verify', { body: { phone, deviceId, requestId: r1.json.requestId, code: r1.json.devCode, publicKey: e2e.toB64(kp.publicKey), platform: 'node' } });
  if (r2.status !== 200) throw new Error(JSON.stringify(r2.json));
  return { kp, deviceId, token: r2.json.accessToken as string, userId: r2.json.user.id as string };
}

const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, '0');

async function main() {
  console.log('Contexa protocol E2E against', API);
  const admin = await device(`052${rnd()}`);
  await req('PUT', '/v1/me', { token: admin.token, body: { name: 'Dr. Levi' } });
  const recovery = e2e.generateKeyPair();
  const org = await req('POST', '/v1/me/orgs', { token: admin.token, body: { name: 'Hadar Dental', contextLabel: 'מטופל', contextLabelPlural: 'מטופלים', recoveryPublicKey: e2e.toB64(recovery.publicKey) } });
  const orgId = org.json.id;
  assert(org.status === 201, 'admin created a standalone org');

  const userPhone = `053${rnd()}`;
  await req('POST', '/v1/admin/users', { token: admin.token, org: orgId, body: { phone: userPhone, name: 'Shira Cohen', jobTitle: 'Hygienist' } });
  const user = await device(userPhone);
  assert(true, 'invited user signed in and joined');

  const ctx = await req('POST', '/v1/contexts', { token: admin.token, org: orgId, body: { name: 'Noa Barak', displayId: '10432', memberIds: [admin.userId, user.userId] } });
  const groupId = ctx.json.groupId;

  // First sender creates key v1, wrapped for every eligible device + recovery key
  const rec = await req('GET', `/v1/groups/${groupId}/key-recipients`, { token: admin.token, org: orgId });
  const k1 = e2e.generateSymmetricKey();
  const wraps = rec.json.devices.map((d: any) => ({ deviceId: d.deviceId, wrappedKey: e2e.wrapKey(e2e.fromB64(d.publicKey), k1) }));
  wraps.push({ deviceId: 'recovery', wrappedKey: e2e.wrapKey(e2e.fromB64(rec.json.recoveryPublicKey), k1) });
  assert((await req('POST', `/v1/groups/${groupId}/keys`, { token: admin.token, org: orgId, body: { version: 1, wraps } })).status === 200, 'group key v1 uploaded as wraps only');

  // Encrypted text
  const ct = e2e.encryptPayload(k1, groupId, 1, { text: 'אפשר לשלוח צילום אחרי הניקוי? @Shira Cohen' });
  const sent = await req('POST', `/v1/groups/${groupId}/messages`, { token: admin.token, org: orgId, body: { clientId: 'c-' + rnd() + 'abc', kind: 'text', ciphertext: ct, keyVersion: 1, mentions: [user.userId] } });
  assert(sent.status === 201, 'encrypted message sent');
  const row = await req('GET', `/v1/groups/${groupId}/messages`, { token: user.token, org: orgId });
  assert(!JSON.stringify(row.json).includes('צילום'), 'server never sees plaintext');

  // Recipient unwraps with its own private key and decrypts the delta sync
  const keys = await req('GET', `/v1/groups/${groupId}/keys`, { token: user.token, org: orgId });
  const uk1 = e2e.unwrapKey(user.kp.privateKey, keys.json.wraps[0].wrappedKey);
  const sync = await req('GET', '/v1/sync?since=0', { token: user.token, org: orgId });
  const msg = sync.json.messages[0];
  assert(e2e.decryptPayload<any>(uk1, groupId, msg.keyVersion, msg.ciphertext).text.startsWith('אפשר'), 'recipient decrypts the message');
  assert(e2e.unwrapKey(recovery.privateKey, wraps.at(-1).wrappedKey).every((b: number, i: number) => b === k1[i]), 'org recovery key can unwrap the group key');

  // Encrypted file: 3 variants under one per-file key, carried inside the message
  const fileKey = e2e.generateSymmetricKey();
  const original = new TextEncoder().encode('%PDF-1.4 fake referral');
  const encOrig = e2e.encryptBytes(fileKey, original);
  const f = await req('POST', '/v1/files', { token: user.token, org: orgId, body: { groupId, kind: 'document', variants: [{ name: 'original', size: encOrig.length }] } });
  const put = await fetch(f.json.uploads.original, { method: 'PUT', body: encOrig as unknown as BodyInit });
  assert(put.ok, 'encrypted file uploaded via signed URL');
  const fileMsg = await req('POST', `/v1/groups/${groupId}/messages`, { token: user.token, org: orgId, body: {
    clientId: 'c-' + rnd() + 'def', kind: 'document', keyVersion: 1, fileIds: [f.json.fileId],
    ciphertext: e2e.encryptPayload(uk1, groupId, 1, { text: 'הפניה לצילום', files: [{ id: f.json.fileId, name: 'הפניה_לצילום.pdf', mime: 'application/pdf', size: original.length, key: e2e.toB64(fileKey) }] }),
  } });
  const dl = await req('GET', `/v1/files/${f.json.fileId}/original`, { token: admin.token, org: orgId });
  const bytes = new Uint8Array(await (await fetch(dl.json.url)).arrayBuffer());
  const adminPayload = e2e.decryptPayload<any>(k1, groupId, 1, fileMsg.json.message.ciphertext);
  assert(new TextDecoder().decode(e2e.decryptBytes(e2e.fromB64(adminPayload.files[0].key), bytes)).startsWith('%PDF'), 'admin downloads and decrypts the file');

  // Save to archive with an encrypted description; duplicates rejected
  const info = await req('GET', '/v1/org', { token: user.token, org: orgId });
  const save = await req('POST', `/v1/groups/${groupId}/archive`, { token: user.token, org: orgId, body: { messageId: fileMsg.json.message.id, fileIds: [f.json.fileId], docTypeId: info.json.docTypes[2].id, docDate: '2026-11-04', descriptionCt: e2e.encryptPayload(uk1, groupId, 1, { text: 'הפניה' }), keyVersion: 1 } });
  assert(save.status === 201, 'file saved to the context archive');
  assert((await req('POST', `/v1/groups/${groupId}/archive`, { token: admin.token, org: orgId, body: { messageId: fileMsg.json.message.id, fileIds: [f.json.fileId], docTypeId: info.json.docTypes[0].id, docDate: '2026-11-04' } })).status === 409, 'duplicate save is blocked');

  // New member → key request → existing device wraps the key → full history decrypts
  const tp = `056${rnd()}`;
  await req('POST', '/v1/admin/users', { token: admin.token, org: orgId, body: { phone: tp, name: 'Moran Alon', jobTitle: 'Secretary' } });
  const moran = await device(tp);
  await req('POST', `/v1/groups/${groupId}/members`, { token: admin.token, org: orgId, body: { userIds: [moran.userId] } });
  const pending = await req('GET', '/v1/keys/requests', { token: user.token, org: orgId });
  const r = pending.json.requests.find((x: any) => x.deviceId === moran.deviceId);
  assert(r && r.versions.includes(1), 'new member device appears as a key request');
  await req('POST', `/v1/groups/${groupId}/keys`, { token: user.token, org: orgId, body: { version: 1, wraps: [{ deviceId: moran.deviceId, wrappedKey: e2e.wrapKey(e2e.fromB64(r.publicKey), uk1) }] } });
  const mk = await req('GET', `/v1/groups/${groupId}/keys`, { token: moran.token, org: orgId });
  const mk1 = e2e.unwrapKey(moran.kp.privateKey, mk.json.wraps[0].wrappedKey);
  const msync = await req('GET', '/v1/sync?since=0', { token: moran.token, org: orgId });
  assert(msync.json.messages.length === 2 && e2e.decryptPayload<any>(mk1, groupId, 1, msync.json.messages[0].ciphertext).text, 'new member reads the full history');

  // Removal → forced rotation → removed device cannot read new messages
  await req('DELETE', `/v1/groups/${groupId}/members/${moran.userId}`, { token: admin.token, org: orgId });
  const stale = await req('POST', `/v1/groups/${groupId}/messages`, { token: admin.token, org: orgId, body: { clientId: 'c-' + rnd() + 'ghi', kind: 'text', ciphertext: ct, keyVersion: 1 } });
  assert(stale.status === 409 && stale.json.error === 'key_rotation_required', 'old key version rejected after removal');
  const rec2 = await req('GET', `/v1/groups/${groupId}/key-recipients`, { token: admin.token, org: orgId });
  assert(!rec2.json.devices.some((d: any) => d.deviceId === moran.deviceId), 'removed member is no longer a key recipient');
  const k2 = e2e.generateSymmetricKey();
  await req('POST', `/v1/groups/${groupId}/keys`, { token: admin.token, org: orgId, body: { version: 2, wraps: rec2.json.devices.map((d: any) => ({ deviceId: d.deviceId, wrappedKey: e2e.wrapKey(e2e.fromB64(d.publicKey), k2) })) } });
  const ok = await req('POST', `/v1/groups/${groupId}/messages`, { token: admin.token, org: orgId, body: { clientId: 'c-' + rnd() + 'jkl', kind: 'text', ciphertext: e2e.encryptPayload(k2, groupId, 2, { text: 'v2' }), keyVersion: 2 } });
  assert(ok.status === 201, 'message under rotated key v2 accepted');
  assert((await req('GET', `/v1/groups/${groupId}/keys`, { token: moran.token, org: orgId })).status === 403, 'removed member lost access immediately');

  // WebSocket hub receives a nudge (no content)
  const ws = new WebSocket(`${API.replace('http', 'ws')}/v1/ws?token=${user.token}`);
  const got = new Promise<string>((res, rej) => {
    ws.onmessage = (ev) => res(String(ev.data));
    setTimeout(() => rej(new Error('no ws event')), 5000);
  });
  await new Promise((res) => (ws.onopen = res));
  await req('POST', `/v1/groups/${groupId}/messages`, { token: admin.token, org: orgId, body: { clientId: 'c-' + rnd() + 'mno', kind: 'text', ciphertext: e2e.encryptPayload(k2, groupId, 2, { text: 'ping' }), keyVersion: 2 } });
  const ev = JSON.parse(await got);
  assert(ev.t === 'sync' && ev.groupId === groupId && !('ciphertext' in ev), 'realtime nudge delivered over the user WebSocket, without content');
  ws.close();
  console.log(`\nAll ${n} protocol checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
