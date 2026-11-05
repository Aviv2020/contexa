import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { audit } from '../lib/audit';
import { maskPhone, normalizePhone, randomId, sha256, signJwt } from '../lib/crypto';
import { fail, now } from '../lib/http';
import { sendSms } from '../lib/inforu';
import { clientIp, rateLimit, requireAuth } from '../middleware';

export const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 90 * 24 * 3600_000;

const auth = new Hono<AppEnv>();

auth.post('/otp/request', async (c) => {
  const body = await c.req.json<{ phone: string; deviceId: string }>();
  const phone = normalizePhone(body.phone ?? '');
  if (!phone) fail(422, 'invalid_phone');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(body.deviceId ?? '')) fail(422, 'invalid_device_id');
  const ip = clientIp(c);
  await rateLimit(c.env, `otp-ip:${ip}`, 20, 900);
  await rateLimit(c.env, `otp-dev:${body.deviceId}`, 6, 900);

  const r = await c.env.OTP.get(c.env.OTP.idFromName(phone)).request(body.deviceId, c.env.OTP_HMAC_SECRET);
  if (!r.ok) {
    await audit(c.env, { orgId: null, action: 'otp.send', actorDeviceId: body.deviceId, ip, meta: { phone: maskPhone(phone), result: r.error } });
    fail(429, r.error, { retryAfterSec: r.retryAfterSec });
  }
  const sent = await sendSms(c.env, phone, `קוד הכניסה שלך ל-Contexa: ${r.code}\nYour Contexa code: ${r.code}`);
  await audit(c.env, { orgId: null, action: 'otp.send', actorDeviceId: body.deviceId, ip, meta: { phone: maskPhone(phone), channel: sent.channel, result: sent.ok ? 'sent' : 'provider_error' } });
  if (!sent.ok) fail(422, 'sms_failed');
  return c.json({ requestId: r.requestId, expiresInSec: 300, ...(c.env.OTP_DEV_MODE === 'true' ? { devCode: r.code } : {}) });
});

auth.post('/otp/verify', async (c) => {
  const body = await c.req.json<{ phone: string; requestId: string; deviceId: string; code: string; publicKey: string; platform?: string; deviceName?: string }>();
  const phone = normalizePhone(body.phone ?? '');
  if (!phone) fail(422, 'invalid_phone');
  if (!/^\d{6}$/.test(body.code ?? '')) fail(422, 'invalid_code');
  if (!body.publicKey || body.publicKey.length > 200) fail(422, 'invalid_public_key');
  const ip = clientIp(c);
  await rateLimit(c.env, `verify-ip:${ip}`, 30, 900);

  const r = await c.env.OTP.get(c.env.OTP.idFromName(phone)).verify(body.requestId, body.deviceId, body.code, c.env.OTP_HMAC_SECRET);
  await audit(c.env, { orgId: null, action: 'otp.verify', actorDeviceId: body.deviceId, ip, meta: { phone: maskPhone(phone), result: r.ok ? 'ok' : r.error } });
  if (!r.ok) fail(401, r.error, { attemptsLeft: r.attemptsLeft });

  const t = now();
  const db = c.env.CENTRAL_DB;
  let user = await db.prepare('SELECT id, name, locale FROM users WHERE phone = ?').bind(phone).first<{ id: string; name: string; locale: string }>();
  if (!user) {
    user = { id: randomId(), name: '', locale: 'he' };
    await db.prepare('INSERT INTO users (id, phone, name, created_at) VALUES (?,?,?,?)').bind(user.id, phone, '', t).run();
  }

  const existing = await db.prepare('SELECT user_id, public_key FROM devices WHERE id = ?').bind(body.deviceId).first<{ user_id: string; public_key: string }>();
  if (existing && existing.user_id !== user.id) fail(409, 'device_id_in_use');
  let keyChanged = false;
  if (existing) {
    keyChanged = existing.public_key !== body.publicKey;
    await db.prepare('UPDATE devices SET public_key = ?, revoked_at = NULL, last_seen_at = ?, platform = ?, name = ? WHERE id = ?')
      .bind(body.publicKey, t, body.platform ?? 'unknown', body.deviceName ?? '', body.deviceId).run();
    // Re-login after a biometric change re-keys the device; older wraps are useless.
    if (keyChanged) await c.env.ORG_DB.prepare('DELETE FROM group_keys WHERE device_id = ?').bind(body.deviceId).run();
  } else {
    await db.prepare('INSERT INTO devices (id, user_id, public_key, platform, name, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .bind(body.deviceId, user.id, body.publicKey, body.platform ?? 'unknown', body.deviceName ?? '', t, t).run();
  }
  // A fresh OTP login lifts per-org revocations for this device (its local data was already wiped).
  await db.prepare('DELETE FROM org_device_revocations WHERE device_id = ?').bind(body.deviceId).run();

  // Accept pending, non-expired invitations: OTP proves ownership of the invited number.
  await db.prepare("UPDATE memberships SET status = 'active', updated_at = ? WHERE user_id = ? AND status = 'invited' AND (invite_expires_at IS NULL OR invite_expires_at > ?)")
    .bind(t, user.id, t).run();

  if (!existing || keyChanged) await requestKeysForNewDevice(c.env, user.id, body.deviceId);

  const tokens = await issueTokens(c.env, user.id, body.deviceId);
  const orgs = await listOrgs(c.env, user.id);
  return c.json({ ...tokens, user: { id: user.id, phone, name: user.name, locale: user.locale }, orgs, needsProfile: !user.name });
});

auth.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();
  const hash = await sha256(refreshToken ?? '');
  const row = await c.env.CENTRAL_DB.prepare(
    `SELECT r.id, r.user_id, r.device_id, r.expires_at, d.revoked_at FROM refresh_tokens r JOIN devices d ON d.id = r.device_id
      WHERE r.token_hash = ? AND r.revoked_at IS NULL`,
  ).bind(hash).first<{ id: string; user_id: string; device_id: string; expires_at: number; revoked_at: number | null }>();
  if (!row || row.expires_at < now() || row.revoked_at) fail(401, 'invalid_refresh');
  await c.env.CENTRAL_DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').bind(now(), row.id).run();
  await c.env.CENTRAL_DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now(), row.device_id).run();
  return c.json(await issueTokens(c.env, row.user_id, row.device_id));
});

auth.post('/logout', requireAuth, async (c) => {
  await c.env.CENTRAL_DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').bind(now(), c.get('auth').deviceId).run();
  return c.json({ ok: true });
});

export async function issueTokens(env: Env, userId: string, deviceId: string) {
  const refreshToken = randomId(32);
  await env.CENTRAL_DB.prepare('INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at) VALUES (?,?,?,?,?)')
    .bind(randomId(), userId, deviceId, await sha256(refreshToken), now() + REFRESH_TTL_MS).run();
  return { accessToken: await signJwt(env.JWT_SECRET, { sub: userId, dev: deviceId }, ACCESS_TTL_SEC), refreshToken, accessExpiresInSec: ACCESS_TTL_SEC };
}

export async function listOrgs(env: Env, userId: string) {
  const { results } = await env.CENTRAL_DB.prepare(
    `SELECT o.id, o.name, o.mode, m.role, m.job_title AS jobTitle FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active' ORDER BY o.name`,
  ).bind(userId).all<{ id: string; name: string; mode: string; role: string; jobTitle: string }>();
  return results;
}

/** A new device needs the group keys of every group the user belongs to; any online member device fulfils the request (§6.5). */
async function requestKeysForNewDevice(env: Env, userId: string, deviceId: string) {
  const { results } = await env.ORG_DB.prepare('SELECT group_id FROM group_members WHERE user_id = ? AND removed_at IS NULL').bind(userId).all<{ group_id: string }>();
  const t = now();
  for (let i = 0; i < results.length; i += 50) {
    await env.ORG_DB.batch(results.slice(i, i + 50).map((r) => env.ORG_DB.prepare('INSERT OR IGNORE INTO key_requests (group_id, device_id, created_at) VALUES (?,?,?)').bind(r.group_id, deviceId, t)));
  }
}

export default auth;
