import type { Env } from '../env';
import { parseJson } from './http';

/** Organisation-level settings managed from the in-app admin screen (§4.6). */
export interface OrgSettings {
  retentionMonths: number;           // messages/files not saved to the archive
  autoLogoutMinutes: number;
  permissions: {
    usersCreateContexts: boolean;
    membersAddMembers: boolean;
    sendFiles: boolean;
    downloadAndShare: boolean;       // blocked by default (§4.3.2)
    deleteMessages: boolean;
    archiveSave: 'all' | 'admins';
  };
  operatingHours: {
    enabled: boolean;                // "do not disturb" outside these hours
    days: number[];                  // 0=Sunday
    start: string;                   // HH:MM
    end: string;
    timezone: string;
  };
  mediaCacheMb: number;
}

export const DEFAULT_SETTINGS: OrgSettings = {
  retentionMonths: 12,
  autoLogoutMinutes: 15,
  permissions: {
    usersCreateContexts: false,
    membersAddMembers: false,
    sendFiles: true,
    downloadAndShare: false,
    deleteMessages: true,
    archiveSave: 'all',
  },
  operatingHours: { enabled: false, days: [0, 1, 2, 3, 4], start: '08:00', end: '20:00', timezone: 'Asia/Jerusalem' },
  mediaCacheMb: 500,
};

function merge<T>(base: T, patch: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      if (k in out && v !== undefined) out[k] = merge(out[k], v);
    }
  }
  return out as T;
}

export async function getSettings(env: Env, orgId: string): Promise<OrgSettings> {
  const cached = await env.CONFIG_KV.get(`settings:${orgId}`);
  if (cached) return merge(DEFAULT_SETTINGS, parseJson(cached, {}));
  const row = await env.ORG_DB.prepare('SELECT settings FROM org_settings WHERE org_id = ?').bind(orgId).first<{ settings: string }>();
  const s = merge(DEFAULT_SETTINGS, parseJson(row?.settings, {}));
  await env.CONFIG_KV.put(`settings:${orgId}`, JSON.stringify(s), { expirationTtl: 300 });
  return s;
}

export function validateSettings(s: OrgSettings): string | null {
  if (!Number.isInteger(s.retentionMonths) || s.retentionMonths < 1 || s.retentionMonths > 120) return 'retentionMonths';
  if (!Number.isInteger(s.autoLogoutMinutes) || s.autoLogoutMinutes < 1 || s.autoLogoutMinutes > 240) return 'autoLogoutMinutes';
  if (!['all', 'admins'].includes(s.permissions.archiveSave)) return 'permissions.archiveSave';
  if (!/^\d\d:\d\d$/.test(s.operatingHours.start) || !/^\d\d:\d\d$/.test(s.operatingHours.end)) return 'operatingHours';
  if (!s.operatingHours.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'operatingHours.days';
  return null;
}

export async function saveSettings(env: Env, orgId: string, patch: unknown): Promise<OrgSettings> {
  const s = merge(await getSettings(env, orgId), patch);
  await env.ORG_DB.prepare(
    'INSERT INTO org_settings (org_id, settings) VALUES (?, ?) ON CONFLICT(org_id) DO UPDATE SET settings = excluded.settings',
  ).bind(orgId, JSON.stringify(s)).run();
  await env.CONFIG_KV.delete(`settings:${orgId}`);
  return s;
}

/** True when `at` falls outside the organisation's operating hours (quiet time). */
export function isQuietTime(s: OrgSettings, at = new Date()): boolean {
  const h = s.operatingHours;
  if (!h.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: h.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const hm = `${parts.find((p) => p.type === 'hour')!.value.replace('24', '00')}:${parts.find((p) => p.type === 'minute')!.value}`;
  if (!h.days.includes(wd)) return true;
  return hm < h.start || hm >= h.end;
}
