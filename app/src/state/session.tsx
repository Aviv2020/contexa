/**
 * Session state machine:
 *   booting → compromised | no-biometrics | signed-out | locked → (needs-profile | no-org | ready)
 * Biometric unlock reads the device private key from secure hardware; locking drops it from memory.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Device from 'expo-device';
import JailMonkey from 'jail-monkey';
import { api, ApiError } from '../api/client';
import type { OrgInfo, OrgMember, OrgSummary } from '../api/types';
import { MAX_BIOMETRIC_FAILURES } from '../config';
import { createDeviceKey, deleteDeviceKey, localDbKey, plainStore, unlockDeviceKey } from '../crypto/deviceKeys';
import { LocalDb } from '../db/local';
import { wipeAllMedia, wipeOrgMedia } from '../media/files';
import { OrgEngine, newClientId } from '../sync/engine';
import { Realtime, type HubEvent } from '../sync/realtime';
import { bus } from './events';

export type Status = 'booting' | 'compromised' | 'no-biometrics' | 'signed-out' | 'rekey' | 'locked' | 'needs-profile' | 'no-org' | 'ready';

export interface User {
  id: string;
  phone: string;
  name: string;
  locale: 'he' | 'en';
}

interface SessionCtx {
  status: Status;
  user: User | null;
  orgs: OrgSummary[];
  org: OrgInfo | null;
  members: OrgMember[];
  engine: OrgEngine | null;
  deviceId: string | null;
  unlockFailures: number;
  notice: { title: string; body: string } | null;
  dismissNotice: () => void;
  requestOtp: (phone: string) => Promise<{ requestId: string; devCode?: string }>;
  verifyOtp: (phone: string, requestId: string, code: string) => Promise<void>;
  unlock: () => Promise<void>;
  lock: () => void;
  selectOrg: (orgId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  refreshOrg: () => Promise<void>;
  createOrg: (input: { name: string; contextLabel: string; contextLabelPlural: string; jobTitle: string; recoveryPublicKey: string }) => Promise<string>;
  setProfile: (name: string) => Promise<void>;
  logout: () => Promise<void>;
  touch: () => void;
  memberName: (userId: string) => string;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('booting');
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [engine, setEngine] = useState<OrgEngine | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [unlockFailures, setUnlockFailures] = useState(0);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  const privateKey = useRef<Uint8Array | null>(null);
  const engineRef = useRef<OrgEngine | null>(null);
  const realtime = useRef<Realtime | null>(null);
  const lastActive = useRef(Date.now());
  const autoLogoutMs = useRef(15 * 60_000);

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    (async () => {
      if (Device.isDevice && JailMonkey.isJailBroken()) return setStatus('compromised');
      const [hw, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!hw || !enrolled) return setStatus('no-biometrics');
      let id = await plainStore.get('deviceId');
      if (!id) {
        id = newClientId() + newClientId();
        await plainStore.set('deviceId', id);
      }
      setDeviceId(id);
      setUnlockFailures(Number((await plainStore.get('bioFailures')) ?? 0));
      const strictest = Number((await plainStore.get('autoLogoutMin')) ?? 15);
      autoLogoutMs.current = strictest * 60_000;
      setStatus((await plainStore.get('refresh')) ? 'locked' : 'signed-out');
    })();
  }, []);

  // ---- helpers ----------------------------------------------------------------
  const closeEngine = useCallback(async () => {
    const e = engineRef.current;
    engineRef.current = null;
    setEngine(null);
    if (e) await e.stop();
  }, []);

  const wipeEverything = useCallback(async (keepDevice: boolean) => {
    await closeEngine();
    realtime.current?.close();
    realtime.current = null;
    const known = JSON.parse((await plainStore.get('knownOrgs')) ?? '[]') as string[];
    for (const o of known) await LocalDb.destroy(o);
    wipeAllMedia();
    await plainStore.del('knownOrgs');
    await plainStore.del('lastOrg');
    await api.clearTokens();
    privateKey.current = null;
    if (!keepDevice) await deleteDeviceKey();
    setUser(null);
    setOrgs([]);
    setOrg(null);
  }, [closeEngine]);

  const wipeOrg = useCallback(async (orgId: string, reason: string) => {
    if (engineRef.current?.orgId === orgId) await closeEngine();
    await LocalDb.destroy(orgId);
    wipeOrgMedia(orgId);
    bus.emit('wiped', { orgId, reason });
    setNotice({ title: 'wiped', body: reason });
  }, [closeEngine]);

  const loadMe = useCallback(async () => {
    const me = await api.get<{ user: User; orgs: OrgSummary[] }>('/v1/me');
    setUser(me.user);
    setOrgs(me.orgs);
    return me;
  }, []);

  const selectOrg = useCallback(async (orgId: string) => {
    if (!privateKey.current || !deviceId) return;
    await closeEngine();
    api.setOrg(orgId);
    const [info, mem] = await Promise.all([api.get<OrgInfo>('/v1/org'), api.get<{ members: OrgMember[] }>('/v1/org/members')]);
    const db = await LocalDb.open(orgId, localDbKey(privateKey.current, orgId));
    const me = user ?? (await loadMe()).user;
    const e = new OrgEngine(orgId, db, privateKey.current, deviceId, me.id);
    engineRef.current = e;
    setEngine(e);
    setOrg(info);
    setMembers(mem.members);
    await plainStore.set('lastOrg', orgId);
    const known = new Set(JSON.parse((await plainStore.get('knownOrgs')) ?? '[]') as string[]);
    known.add(orgId);
    await plainStore.set('knownOrgs', JSON.stringify([...known]));
    // Device-level security settings: the strictest across the user's orgs applies (§3.5).
    const perOrg = JSON.parse((await plainStore.get('autoLogoutByOrg')) ?? '{}') as Record<string, number>;
    perOrg[orgId] = info.settings.autoLogoutMinutes;
    await plainStore.set('autoLogoutByOrg', JSON.stringify(perOrg));
    const strictest = Math.min(...Object.values(perOrg));
    await plainStore.set('autoLogoutMin', String(strictest));
    autoLogoutMs.current = strictest * 60_000;
    setStatus('ready');
    void e.start();
  }, [closeEngine, deviceId, loadMe, user]);

  const enter = useCallback(async () => {
    const me = await loadMe();
    if (!me.user.name) return setStatus('needs-profile');
    if (!me.orgs.length) return setStatus('no-org');
    const last = await plainStore.get('lastOrg');
    const target = me.orgs.find((o) => o.id === last) ?? (me.orgs.length === 1 ? me.orgs[0] : null);
    if (target) await selectOrg(target.id);
    else setStatus('no-org'); // the org picker is shown in this state when there are several orgs
    if (!realtime.current) {
      realtime.current = new Realtime((ev: HubEvent) => {
        const cur = engineRef.current;
        if (ev.t === 'wipe') {
          if (ev.reason === 'removed_from_group' && ev.groupId && cur?.orgId === ev.orgId) {
            void cur.db.dropGroup(ev.groupId).then(() => bus.emit('removedFromGroup', { orgId: ev.orgId, groupId: ev.groupId! }));
          } else void wipeOrg(ev.orgId, ev.reason ?? 'revoked').then(loadMe);
          return;
        }
        if (cur && (ev.orgId === cur.orgId || ev.orgId === '*')) void cur.handleEvent(ev);
        if (ev.orgId !== cur?.orgId) void loadMe().catch(() => undefined); // unread counts for the org switcher
      });
      void realtime.current.connect();
    }
  }, [loadMe, selectOrg, wipeOrg]);

  // ---- auth -------------------------------------------------------------------
  const requestOtp = useCallback(async (phone: string) => {
    return api.post<{ requestId: string; devCode?: string }>('/v1/auth/otp/request', { phone, deviceId }, { auth: false });
  }, [deviceId]);

  const verifyOtp = useCallback(async (phone: string, requestId: string, code: string) => {
    const { publicKey } = await createDeviceKey();
    const r = await api.post<{ accessToken: string; refreshToken: string; accessExpiresInSec: number }>(
      '/v1/auth/otp/verify',
      { phone, requestId, code, deviceId, publicKey, platform: Platform.OS, deviceName: Device.modelName ?? '' },
      { auth: false },
    );
    await api.setTokens(r);
    // Biometric set-up step: unlock the freshly created key once (§3.5 step 5).
    const u = await unlockDeviceKey();
    if (!u.ok) throw new ApiError(401, 'biometric_failed');
    privateKey.current = u.privateKey;
    await plainStore.set('bioFailures', '0');
    setUnlockFailures(0);
    lastActive.current = Date.now();
    await enter();
  }, [deviceId, enter]);

  const unlock = useCallback(async () => {
    const r = await unlockDeviceKey();
    if (r.ok) {
      privateKey.current = r.privateKey;
      await plainStore.set('bioFailures', '0');
      setUnlockFailures(0);
      lastActive.current = Date.now();
      try {
        await enter();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await wipeEverything(true);
          setStatus('signed-out');
        } else throw e;
      }
      return;
    }
    if (r.reason === 'missing') {
      // Biometrics changed → device key invalidated → full local wipe and OTP re-login (§4.1).
      await wipeEverything(false);
      return setStatus('rekey');
    }
    const n = unlockFailures + 1;
    setUnlockFailures(n);
    await plainStore.set('bioFailures', String(n));
    if (n >= MAX_BIOMETRIC_FAILURES) {
      await wipeEverything(false); // local wipe after 5 failed biometric attempts (§6.1)
      await plainStore.set('bioFailures', '0');
      setUnlockFailures(0);
      setStatus('signed-out');
    }
  }, [enter, unlockFailures, wipeEverything]);

  const lock = useCallback(() => {
    privateKey.current = null;
    void closeEngine();
    setStatus((s) => (s === 'ready' || s === 'no-org' || s === 'needs-profile' ? 'locked' : s));
  }, [closeEngine]);

  const logout = useCallback(async () => {
    await api.post('/v1/auth/logout').catch(() => undefined);
    await wipeEverything(false);
    setStatus('signed-out');
  }, [wipeEverything]);

  // Remote revocation / deactivation surfaced by any API call.
  useEffect(() => api.onFatal((e) => {
    if (e.code === 'session_expired' || e.code === 'device_revoked') {
      void wipeEverything(false).then(() => setStatus('signed-out'));
    } else if (api.org) {
      const orgId = api.org;
      void wipeOrg(orgId, e.code).then(async () => {
        const me = await loadMe().catch(() => null);
        const next = me?.orgs.find((o) => o.id !== orgId);
        if (next) await selectOrg(next.id);
        else setStatus('no-org');
      });
    }
  }), [loadMe, selectOrg, wipeEverything, wipeOrg]);

  // ---- auto-logout after inactivity (§4.1) --------------------------------------
  const touch = useCallback(() => {
    lastActive.current = Date.now();
  }, []);
  useEffect(() => {
    const check = () => {
      if (Date.now() - lastActive.current > autoLogoutMs.current) lock();
    };
    const iv = setInterval(check, 15_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
      else lastActive.current = Math.min(lastActive.current, Date.now());
    });
    return () => {
      clearInterval(iv);
      sub.remove();
    };
  }, [lock]);

  const value = useMemo<SessionCtx>(() => ({
    status, user, orgs, org, members, engine, deviceId, unlockFailures, notice,
    dismissNotice: () => setNotice(null),
    requestOtp, verifyOtp, unlock, lock, selectOrg, logout, touch,
    refreshMe: async () => void (await loadMe()),
    refreshOrg: async () => {
      const [info, mem] = await Promise.all([api.get<OrgInfo>('/v1/org'), api.get<{ members: OrgMember[] }>('/v1/org/members')]);
      setOrg(info);
      setMembers(mem.members);
    },
    createOrg: async (input) => {
      const r = await api.post<{ id: string }>('/v1/me/orgs', input);
      await loadMe();
      await selectOrg(r.id);
      return r.id;
    },
    setProfile: async (name) => {
      await api.put('/v1/me', { name });
      await enter();
    },
    memberName: (id: string) => members.find((m) => m.id === id)?.name ?? '',
  }), [status, user, orgs, org, members, engine, deviceId, unlockFailures, notice, requestOtp, verifyOtp, unlock, lock, selectOrg, logout, touch, loadMe, enter]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
