import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, login, newDeviceId } from './helpers';
import { runRetention } from '../src/retention';
import { isQuietTime, DEFAULT_SETTINGS } from '../src/lib/settings';
import { parseCsv, toCsv } from '../src/lib/csv';
import { normalizePhone, randomDigits } from '../src/lib/crypto';

let phoneSeq = 1000000;
const phone = () => `05${++phoneSeq}0`.slice(0, 10);

async function setupOrg() {
  const admin = await login(phone());
  await call('PUT', '/v1/me', { token: admin.token, body: { name: 'ד״ר לוי' } });
  const org = await call('POST', '/v1/me/orgs', {
    token: admin.token,
    body: { name: 'מרפאת שיניים הדר', contextLabel: 'מטופל', contextLabelPlural: 'מטופלים', recoveryPublicKey: 'recovery-pk', jobTitle: 'רופא מטפל' },
  });
  expect(org.status).toBe(201);
  const orgId = org.json.id as string;
  const userPhone = phone();
  const inv = await call('POST', '/v1/admin/users', { token: admin.token, org: orgId, body: { phone: userPhone, name: 'שירה כהן', jobTitle: 'שיננית' } });
  expect(inv.status).toBe(201);
  const user = await login(userPhone);
  return { admin, user, orgId };
}

async function createGroup(admin: { token: string }, orgId: string, memberIds: string[]) {
  const r = await call('POST', '/v1/contexts', { token: admin.token, org: orgId, body: { name: 'נועה ברק', displayId: '10432', header: { age: '41' }, memberIds } });
  expect(r.status).toBe(201);
  return r.json as { contextId: string; groupId: string };
}

async function createKey(u: { token: string; deviceId: string }, orgId: string, groupId: string, version: number) {
  const r = await call('POST', `/v1/groups/${groupId}/keys`, { token: u.token, org: orgId, body: { version, wraps: [{ deviceId: u.deviceId, wrappedKey: `wrap-${version}` }, { deviceId: 'recovery', wrappedKey: 'rwrap' }] } });
  expect(r.status).toBe(200);
}

let clientSeq = 0;
const send = (u: { token: string }, orgId: string, groupId: string, extra: Record<string, unknown> = {}) =>
  call('POST', `/v1/groups/${groupId}/messages`, { token: u.token, org: orgId, body: { clientId: `client-${++clientSeq}-abcdef`, kind: 'text', ciphertext: 'ct', keyVersion: 1, ...extra } });

describe('auth / OTP', () => {
  it('logs in with OTP, refreshes and rotates refresh tokens', async () => {
    const a = await login('0501111111');
    expect(a.user.phone).toBe('+972501111111');
    expect(a.orgs).toEqual([]);
    const r = await call('POST', '/v1/auth/refresh', { body: { refreshToken: a.refreshToken } });
    expect(r.status).toBe(200);
    const again = await call('POST', '/v1/auth/refresh', { body: { refreshToken: a.refreshToken } });
    expect(again.status).toBe(401);
  });

  it('enforces resend delay, attempt limit and device binding', async () => {
    const deviceId = newDeviceId();
    const headers = { 'cf-connecting-ip': '10.9.9.9' };
    const r1 = await call('POST', '/v1/auth/otp/request', { body: { phone: '0502222222', deviceId }, headers });
    expect(r1.status).toBe(200);
    const r2 = await call('POST', '/v1/auth/otp/request', { body: { phone: '0502222222', deviceId }, headers });
    expect(r2.status).toBe(429);
    expect(r2.json.error).toBe('resend_too_soon');

    const wrongDevice = await call('POST', '/v1/auth/otp/verify', { body: { phone: '0502222222', deviceId: newDeviceId(), requestId: r1.json.requestId, code: r1.json.devCode, publicKey: 'pk' }, headers });
    expect(wrongDevice.json.error).toBe('wrong_device');

    const bad = r1.json.devCode === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const v = await call('POST', '/v1/auth/otp/verify', { body: { phone: '0502222222', deviceId, requestId: r1.json.requestId, code: bad, publicKey: 'pk' }, headers });
      expect(v.json).toMatchObject({ error: 'mismatch', attemptsLeft: 5 - i });
    }
    const fifth = await call('POST', '/v1/auth/otp/verify', { body: { phone: '0502222222', deviceId, requestId: r1.json.requestId, code: bad, publicKey: 'pk' }, headers });
    expect(fifth.json.error).toBe('too_many_attempts');
    // Even the right code is now rejected: the code was burned.
    const right = await call('POST', '/v1/auth/otp/verify', { body: { phone: '0502222222', deviceId, requestId: r1.json.requestId, code: r1.json.devCode, publicKey: 'pk' }, headers });
    expect(right.status).toBe(401);
  });

  it('never stores the plain code and audits sends with a masked number', async () => {
    await login('0503333333');
    const row = await env.ORG_DB.prepare("SELECT meta FROM audit_log WHERE action = 'otp.send' ORDER BY id DESC LIMIT 1").first<{ meta: string }>();
    expect(JSON.parse(row!.meta).phone).toMatch(/^\+972\*+333$/);
  });

  it('rejects unauthenticated requests', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', { token: 'x.y.z' })).status).toBe(401);
  });
});

describe('organisations and membership', () => {
  it('creates an org, invites a user who joins on first login, and lists orgs with unread counts', async () => {
    const { admin, user, orgId } = await setupOrg();
    expect(user.orgs.map((o: { id: string }) => o.id)).toContain(orgId);
    const me = await call('GET', '/v1/me', { token: admin.token });
    expect(me.json.orgs[0]).toMatchObject({ id: orgId, role: 'admin', unread: 0 });
    const info = await call('GET', '/v1/org', { token: user.token, org: orgId });
    expect(info.json.contextType.label).toBe('מטופל');
    expect(info.json.settings.permissions.downloadAndShare).toBe(false);
    expect(info.json.settings.retentionMonths).toBe(12);
    expect(info.json.settings.autoLogoutMinutes).toBe(15);
    // Non-admins can't reach the admin API
    expect((await call('GET', '/v1/admin/users', { token: user.token, org: orgId })).status).toBe(403);
    // No access to an org you are not a member of
    const stranger = await login(phone());
    expect((await call('GET', '/v1/groups', { token: stranger.token, org: orgId })).status).toBe(403);
  });
});

describe('groups, keys and messages', () => {
  it('runs a full chat flow with E2E key wraps, receipts, edit and delete', async () => {
    const { admin, user, orgId } = await setupOrg();
    const { groupId } = await createGroup(admin, orgId, [admin.userId, user.userId]);

    // No key yet: sending must fail until the first sender creates version 1
    expect((await send(admin, orgId, groupId)).json.error).toBe('key_rotation_required');
    const rec = await call('GET', `/v1/groups/${groupId}/key-recipients`, { token: admin.token, org: orgId });
    expect(rec.json.devices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual([admin.deviceId, user.deviceId].sort());
    expect(rec.json.recoveryPublicKey).toBe('recovery-pk');
    await createKey(admin, orgId, groupId, 1);

    // The user's device was not wrapped: it shows up as a key request that the admin's device can fulfil
    const reqs = await call('GET', '/v1/keys/requests', { token: admin.token, org: orgId });
    expect(reqs.json.requests).toEqual([expect.objectContaining({ groupId, deviceId: user.deviceId, versions: [1] })]);
    await call('POST', `/v1/groups/${groupId}/keys`, { token: admin.token, org: orgId, body: { version: 1, wraps: [{ deviceId: user.deviceId, wrappedKey: 'w' }] } });
    expect((await call('GET', '/v1/keys/requests', { token: admin.token, org: orgId })).json.requests).toEqual([]);
    const userKeys = await call('GET', `/v1/groups/${groupId}/keys`, { token: user.token, org: orgId });
    expect(userKeys.json.wraps).toEqual([expect.objectContaining({ version: 1, wrappedKey: 'w' })]);

    const m1 = await send(admin, orgId, groupId, { mentions: [user.userId, 'not-a-member'] });
    expect(m1.status).toBe(201);
    expect(m1.json.message).toMatchObject({ seq: 1, mentions: [user.userId] });
    // Idempotent on clientId (offline outbox retries)
    const dup = await call('POST', `/v1/groups/${groupId}/messages`, { token: admin.token, org: orgId, body: { clientId: m1.json.message.clientId, kind: 'text', ciphertext: 'ct', keyVersion: 1 } });
    expect(dup.json.duplicate).toBe(true);

    const list = await call('GET', '/v1/groups', { token: user.token, org: orgId });
    expect(list.json.groups[0]).toMatchObject({ id: groupId, unread: 1, name: 'נועה ברק', displayId: '10432' });
    expect((await call('GET', '/v1/groups?filter=unread', { token: user.token, org: orgId })).json.groups).toHaveLength(1);
    expect((await call('GET', '/v1/groups?q=10432', { token: user.token, org: orgId })).json.groups).toHaveLength(1);
    expect((await call('GET', '/v1/groups?q=zzz', { token: user.token, org: orgId })).json.groups).toHaveLength(0);

    const sync = await call('GET', '/v1/sync?since=0', { token: user.token, org: orgId });
    expect(sync.json.messages).toHaveLength(1);
    const cursor = sync.json.cursor;
    expect((await call('GET', `/v1/sync?since=${cursor}`, { token: user.token, org: orgId })).json.messages).toHaveLength(0);

    await call('POST', `/v1/groups/${groupId}/receipts`, { token: user.token, org: orgId, body: { readSeq: 1 } });
    const receipts = await call('GET', `/v1/messages/${m1.json.message.id}/receipts`, { token: admin.token, org: orgId });
    expect(receipts.json.receipts.find((r: { userId: string }) => r.userId === user.userId)).toMatchObject({ read: 1, delivered: 1 });
    expect((await call('GET', '/v1/groups?filter=unread', { token: user.token, org: orgId })).json.groups).toHaveLength(0);

    // Edit + delete by the sender only
    expect((await call('PUT', `/v1/messages/${m1.json.message.id}`, { token: user.token, org: orgId, body: { ciphertext: 'x', keyVersion: 1 } })).status).toBe(403);
    expect((await call('PUT', `/v1/messages/${m1.json.message.id}`, { token: admin.token, org: orgId, body: { ciphertext: 'ct2', keyVersion: 1 } })).status).toBe(200);
    const after = await call('GET', `/v1/sync?since=${cursor}`, { token: user.token, org: orgId });
    expect(after.json.messages[0]).toMatchObject({ ciphertext: 'ct2', editedAt: expect.any(Number) });
    expect((await call('DELETE', `/v1/messages/${m1.json.message.id}`, { token: admin.token, org: orgId })).status).toBe(200);
    const page = await call('GET', `/v1/groups/${groupId}/messages`, { token: user.token, org: orgId });
    expect(page.json.messages[0]).toMatchObject({ ciphertext: null, deletedAt: expect.any(Number) });
    const auditRow = await env.ORG_DB.prepare("SELECT 1 AS x FROM audit_log WHERE action = 'message.delete' AND target_id = ?").bind(m1.json.message.id).first();
    expect(auditRow).not.toBeNull();

    // 15-minute window
    const m2 = await send(admin, orgId, groupId);
    await env.ORG_DB.prepare('UPDATE messages SET created_at = created_at - ? WHERE id = ?').bind(16 * 60_000, m2.json.message.id).run();
    expect((await call('DELETE', `/v1/messages/${m2.json.message.id}`, { token: admin.token, org: orgId })).json.error).toBe('edit_window_passed');
  });

  it('removing a member cuts access immediately and forces key rotation', async () => {
    const { admin, user, orgId } = await setupOrg();
    const { groupId } = await createGroup(admin, orgId, [admin.userId, user.userId]);
    await createKey(admin, orgId, groupId, 1);
    expect((await send(user, orgId, groupId)).status).toBe(201);

    expect((await call('DELETE', `/v1/groups/${groupId}/members/${user.userId}`, { token: admin.token, org: orgId })).status).toBe(200);
    const denied = await send(user, orgId, groupId);
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('not_a_group_member');
    expect((await call('GET', `/v1/groups/${groupId}/messages`, { token: user.token, org: orgId })).status).toBe(403);
    expect((await call('GET', '/v1/sync?since=0', { token: user.token, org: orgId })).json.messages).toHaveLength(0);

    // Old key version is no longer accepted
    expect((await send(admin, orgId, groupId)).json).toMatchObject({ error: 'key_rotation_required', minKeyVersion: 2 });
    await createKey(admin, orgId, groupId, 2);
    // The removed user's device is no longer an eligible recipient
    const bad = await call('POST', `/v1/groups/${groupId}/keys`, { token: admin.token, org: orgId, body: { version: 2, wraps: [{ deviceId: user.deviceId, wrappedKey: 'x' }] } });
    expect(bad.json.stored).toBe(0);
    expect((await send(admin, orgId, groupId, { keyVersion: 2 })).status).toBe(201);

    // Re-adding gives back the full history (key request for every version)
    await call('POST', `/v1/groups/${groupId}/members`, { token: admin.token, org: orgId, body: { userIds: [user.userId] } });
    const reqs = await call('GET', '/v1/keys/requests', { token: admin.token, org: orgId });
    expect(reqs.json.requests[0]).toMatchObject({ deviceId: user.deviceId, versions: [1, 2] });
  });

  it('only allows adding members of the same org, and only admins create contexts by default', async () => {
    const { admin, user, orgId } = await setupOrg();
    const outsider = await login(phone());
    const { groupId } = await createGroup(admin, orgId, [admin.userId]);
    const r = await call('POST', `/v1/groups/${groupId}/members`, { token: admin.token, org: orgId, body: { userIds: [outsider.userId] } });
    expect(r.json.error).toBe('no_valid_users');
    expect((await call('POST', '/v1/contexts', { token: user.token, org: orgId, body: { name: 'x' } })).status).toBe(403);
    await call('PUT', '/v1/admin/settings', { token: admin.token, org: orgId, body: { permissions: { usersCreateContexts: true } } });
    expect((await call('POST', '/v1/contexts', { token: user.token, org: orgId, body: { name: 'x' } })).status).toBe(201);
  });

  it('archived contexts become read-only but stay searchable', async () => {
    const { admin, orgId } = await setupOrg();
    const { groupId, contextId } = await createGroup(admin, orgId, [admin.userId]);
    await createKey(admin, orgId, groupId, 1);
    await call('PATCH', `/v1/contexts/${contextId}`, { token: admin.token, org: orgId, body: { archived: true } });
    expect((await send(admin, orgId, groupId)).json.error).toBe('group_archived');
    expect((await call('GET', '/v1/groups', { token: admin.token, org: orgId })).json.groups).toHaveLength(0);
    expect((await call('GET', '/v1/groups?filter=archived', { token: admin.token, org: orgId })).json.groups).toHaveLength(1);
    expect((await call('GET', '/v1/groups?q=נועה', { token: admin.token, org: orgId })).json.groups).toHaveLength(1);
  });
});

describe('files and context archive', () => {
  it('uploads encrypted variants, saves to the archive once, and keeps it after the message is deleted', async () => {
    const { admin, user, orgId } = await setupOrg();
    const { groupId, contextId } = await createGroup(admin, orgId, [admin.userId, user.userId]);
    await createKey(admin, orgId, groupId, 1);

    const tooBig = await call('POST', '/v1/files', { token: user.token, org: orgId, body: { groupId, kind: 'document', variants: [{ name: 'original', size: 26 * 1024 * 1024 }] } });
    expect(tooBig.status).toBe(413);

    const f = await call('POST', '/v1/files', { token: user.token, org: orgId, body: { groupId, kind: 'image', variants: [{ name: 'thumb', size: 4 }, { name: 'original', size: 8 }] } });
    expect(f.status).toBe(201);
    const putPath = new URL(f.json.uploads.original).pathname;
    expect((await call('PUT', putPath, { raw: new Uint8Array(8), headers: { 'content-length': '8' } })).status).toBe(200);
    expect((await call('PUT', putPath, { raw: new Uint8Array(8), headers: { 'content-length': '8' } })).status).toBe(409);
    await call('PUT', new URL(f.json.uploads.thumb).pathname, { raw: new Uint8Array(4), headers: { 'content-length': '4' } });

    const msg = await send(user, orgId, groupId, { kind: 'image', fileIds: [f.json.fileId] });
    expect(msg.status).toBe(201);
    const dl = await call('GET', `/v1/files/${f.json.fileId}/original`, { token: admin.token, org: orgId });
    const blob = await call('GET', new URL(dl.json.url).pathname);
    expect(blob.status).toBe(200);
    expect(blob.headers.get('cache-control')).toContain('immutable');
    const outsider = await login(phone());
    expect((await call('GET', `/v1/files/${f.json.fileId}/original`, { token: outsider.token, org: orgId })).status).toBe(403);

    const org = await call('GET', '/v1/org', { token: user.token, org: orgId });
    const docTypeId = org.json.docTypes[0].id;
    const save = await call('POST', `/v1/groups/${groupId}/archive`, { token: user.token, org: orgId, body: { messageId: msg.json.message.id, fileIds: [f.json.fileId], docTypeId, docDate: '2026-11-04', descriptionCt: 'enc-desc', keyVersion: 1 } });
    expect(save.status).toBe(201);
    const again = await call('POST', `/v1/groups/${groupId}/archive`, { token: admin.token, org: orgId, body: { messageId: msg.json.message.id, fileIds: [f.json.fileId], docTypeId, docDate: '2026-11-04' } });
    expect(again.status).toBe(409);
    expect(again.json.existing[0]).toMatchObject({ savedBy: user.userId });

    const sync = await call('GET', '/v1/sync?since=0', { token: admin.token, org: orgId });
    expect(sync.json.messages.find((m: { id: string }) => m.id === msg.json.message.id).archive[0]).toMatchObject({ docTypeId, savedBy: user.userId, status: 'saved' });

    await call('DELETE', `/v1/messages/${msg.json.message.id}`, { token: user.token, org: orgId });
    const arch = await call('GET', `/v1/contexts/${contextId}/archive`, { token: admin.token, org: orgId });
    expect(arch.json.documents).toHaveLength(1);
    expect(arch.json.documents[0]).toMatchObject({ docDate: '2026-11-04', descriptionCt: 'enc-desc' });
    expect((await call('GET', `/v1/contexts/${contextId}/archive?from=2026-12-01`, { token: admin.token, org: orgId })).json.documents).toHaveLength(0);

    // Only admins remove from the archive; it is audited
    expect((await call('DELETE', `/v1/archive/${arch.json.documents[0].id}`, { token: user.token, org: orgId })).status).toBe(403);
    expect((await call('DELETE', `/v1/archive/${arch.json.documents[0].id}`, { token: admin.token, org: orgId })).status).toBe(200);
  });

  it('respects the org permission for saving to the archive', async () => {
    const { admin, user, orgId } = await setupOrg();
    const { groupId } = await createGroup(admin, orgId, [admin.userId, user.userId]);
    await call('PUT', '/v1/admin/settings', { token: admin.token, org: orgId, body: { permissions: { archiveSave: 'admins' } } });
    const r = await call('POST', `/v1/groups/${groupId}/archive`, { token: user.token, org: orgId, body: { messageId: 'x', fileIds: ['y'], docTypeId: 'z', docDate: '2026-11-04' } });
    expect(r.json.error).toBe('archive_not_allowed');
  });
});

describe('admin', () => {
  it('deactivating a member removes them from all groups and the org', async () => {
    const { admin, user, orgId } = await setupOrg();
    const g1 = await createGroup(admin, orgId, [admin.userId, user.userId]);
    const g2 = await createGroup(admin, orgId, [user.userId]);
    const r = await call('POST', `/v1/admin/users/${user.userId}/deactivate`, { token: admin.token, org: orgId });
    expect(r.json.removedFromGroups).toBe(2);
    const denied = await call('GET', '/v1/groups', { token: user.token, org: orgId });
    expect(denied.json).toMatchObject({ error: 'membership_deactivated', wipe: true });
    const g = await env.ORG_DB.prepare('SELECT min_key_version FROM groups WHERE id = ?').bind(g1.groupId).first<{ min_key_version: number }>();
    expect(g!.min_key_version).toBe(1);
    expect((await call('POST', `/v1/admin/users/${admin.userId}/deactivate`, { token: admin.token, org: orgId })).json.error).toBe('cannot_deactivate_owner');
    expect(g2.groupId).toBeTruthy();
  });

  it('revokes a device for this org only', async () => {
    const { admin, user, orgId } = await setupOrg();
    const other = await call('POST', '/v1/me/orgs', { token: user.token, body: { name: 'Other', contextLabel: 'לקוח', contextLabelPlural: 'לקוחות', recoveryPublicKey: 'k' } });
    const devices = await call('GET', '/v1/admin/devices', { token: admin.token, org: orgId });
    expect(devices.json.devices.map((d: { id: string }) => d.id)).toContain(user.deviceId);
    expect((await call('POST', `/v1/admin/devices/${user.deviceId}/revoke`, { token: admin.token, org: orgId })).status).toBe(200);
    expect((await call('GET', '/v1/groups', { token: user.token, org: orgId })).json).toMatchObject({ error: 'device_revoked_for_org', wipe: true });
    expect((await call('GET', '/v1/groups', { token: user.token, org: other.json.id })).status).toBe(200);
  });

  it('imports contexts from CSV, manages settings and exports the audit log', async () => {
    const { admin, orgId } = await setupOrg();
    const csv = 'name,display_id,external_id,age,members\n"כהן, יוסי",10301,ext-1,52,0501234567\nדנה פרץ,08854,ext-2,,\n,1,2,,\nדנה פרץ,08854,ext-2,,\n';
    const r = await call('POST', '/v1/admin/contexts/import', { token: admin.token, org: orgId, raw: csv, headers: { 'content-type': 'text/csv' } });
    expect(r.json.created).toBe(2);
    expect(r.json.errors.map((e: { error: string }) => e.error)).toEqual(['missing_name', 'duplicate_external_id']);
    const groups = await call('GET', '/v1/groups?scope=all', { token: admin.token, org: orgId });
    expect(groups.json.groups.find((g: { name: string }) => g.name === 'כהן, יוסי').header).toEqual({ age: '52' });

    expect((await call('PUT', '/v1/admin/settings', { token: admin.token, org: orgId, body: { retentionMonths: 0 } })).status).toBe(422);
    const s = await call('PUT', '/v1/admin/settings', { token: admin.token, org: orgId, body: { autoLogoutMinutes: 5, operatingHours: { enabled: true } } });
    expect(s.json).toMatchObject({ autoLogoutMinutes: 5, retentionMonths: 12, operatingHours: { enabled: true, start: '08:00' } });

    const audit = await call('GET', '/v1/admin/audit?action=context', { token: admin.token, org: orgId });
    expect(audit.json.entries[0].action).toBe('context.import');
    const exp = await call('GET', '/v1/admin/audit.csv', { token: admin.token, org: orgId });
    expect(exp.headers.get('content-type')).toContain('text/csv');
    expect(exp.json).toContain('context.import');
  });
});

describe('retention', () => {
  it('purges old messages and files that were not saved to the archive', async () => {
    const { admin, orgId } = await setupOrg();
    const { groupId } = await createGroup(admin, orgId, [admin.userId]);
    await createKey(admin, orgId, groupId, 1);
    const mk = async () => {
      const f = await call('POST', '/v1/files', { token: admin.token, org: orgId, body: { groupId, kind: 'image', variants: [{ name: 'original', size: 3 }] } });
      await call('PUT', new URL(f.json.uploads.original).pathname, { raw: new Uint8Array(3), headers: { 'content-length': '3' } });
      const m = await send(admin, orgId, groupId, { kind: 'image', fileIds: [f.json.fileId] });
      return { fileId: f.json.fileId as string, messageId: m.json.message.id as string };
    };
    const kept = await mk();
    const purged = await mk();
    const org = await call('GET', '/v1/org', { token: admin.token, org: orgId });
    await call('POST', `/v1/groups/${groupId}/archive`, { token: admin.token, org: orgId, body: { messageId: kept.messageId, fileIds: [kept.fileId], docTypeId: org.json.docTypes[0].id, docDate: '2026-01-01' } });
    await env.ORG_DB.prepare('UPDATE messages SET created_at = 0 WHERE group_id = ?').bind(groupId).run();

    await runRetention(env);
    expect(await env.FILES.head(`${orgId}/${purged.fileId}/original`)).toBeNull();
    expect(await env.FILES.head(`${orgId}/${kept.fileId}/original`)).not.toBeNull();
    expect(await env.ORG_DB.prepare('SELECT 1 FROM messages WHERE id = ?').bind(purged.messageId).first()).toBeNull();
    expect(await env.ORG_DB.prepare('SELECT 1 FROM messages WHERE id = ?').bind(kept.messageId).first()).not.toBeNull();
  });
});

describe('units', () => {
  it('normalises phone numbers', () => {
    expect(normalizePhone('050-123-4567')).toBe('+972501234567');
    expect(normalizePhone('00972501234567')).toBe('+972501234567');
    expect(normalizePhone('abc')).toBeNull();
  });
  it('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(randomDigits()).toMatch(/^\d{6}$/);
  });
  it('detects quiet hours', () => {
    const s = { ...DEFAULT_SETTINGS, operatingHours: { ...DEFAULT_SETTINGS.operatingHours, enabled: true } };
    expect(isQuietTime(s, new Date('2026-11-01T09:00:00Z'))).toBe(false); // Sunday 11:00 Israel
    expect(isQuietTime(s, new Date('2026-11-01T20:00:00Z'))).toBe(true); // Sunday 22:00
    expect(isQuietTime(s, new Date('2026-11-06T09:00:00Z'))).toBe(true); // Friday
  });
  it('round-trips CSV and neutralises formulas', () => {
    expect(parseCsv('a,"b,""c"""\r\n1,2')).toEqual([['a', 'b,"c"'], ['1', '2']]);
    expect(toCsv([['=cmd()']])).toContain("'=cmd()");
  });
});
