import type { Env } from '../env';
import { getSettings, isQuietTime } from './settings';

/**
 * Push carries only a generic "new message" signal — never the context name or content (§4.4, §7.7).
 * Delivered through the Expo push service, which relays to APNs / FCM.
 */
export async function pushNewMessage(env: Env, orgId: string, groupId: string, senderId: string, mentions: string[]): Promise<void> {
  const settings = await getSettings(env, orgId);
  const quiet = isQuietTime(settings);
  const nowMs = Date.now();
  const { results } = await env.ORG_DB.prepare(
    `SELECT gm.user_id, COALESCE(s.muted_until, 0) AS muted_until
       FROM group_members gm LEFT JOIN group_user_state s ON s.group_id = gm.group_id AND s.user_id = gm.user_id
      WHERE gm.group_id = ? AND gm.removed_at IS NULL AND gm.user_id != ?`,
  ).bind(groupId, senderId).all<{ user_id: string; muted_until: number }>();

  const recipients = results.filter((r) => {
    const mentioned = mentions.includes(r.user_id);
    const muted = r.muted_until === -1 || r.muted_until > nowMs;
    if (mentioned) return !quiet;       // a mention overrides a muted group, not quiet hours
    return !muted && !quiet;
  });
  if (!recipients.length) return;

  const ids = recipients.map((r) => r.user_id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: devices } = await env.CENTRAL_DB.prepare(
    `SELECT d.push_token, u.locale FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.user_id IN (${placeholders}) AND d.revoked_at IS NULL AND d.push_token IS NOT NULL
        AND d.id NOT IN (SELECT device_id FROM org_device_revocations WHERE org_id = ?)`,
  ).bind(...ids, orgId).all<{ push_token: string; locale: string }>();
  if (!devices.length) return;

  const messages = devices.map((d) => ({
    to: d.push_token,
    title: 'Contexa',
    body: d.locale === 'en' ? 'New message in Contexa' : 'הודעה חדשה ב-Contexa',
    data: { orgId, groupId },
    sound: 'default',
    priority: 'high',
  }));
  for (let i = 0; i < messages.length; i += 100) {
    await fetch(env.EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    }).catch((e) => console.error('push failed', e));
  }
}
