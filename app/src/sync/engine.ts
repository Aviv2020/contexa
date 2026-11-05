/**
 * Per-organisation sync engine (§6.5, §7.7):
 *  - delta sync by org-wide revision cursor; history pages on demand
 *  - group-key management: unwrap, create/rotate versions, fulfil other devices' key requests in the background
 *  - offline outbox with idempotent client ids
 *  - batched, debounced read/delivered receipts
 */
import { api, ApiError } from '../api/client';
import type { GroupSummary, ServerMessage } from '../api/types';
import {
  decryptPayload, encryptPayload, fromB64, generateSymmetricKey, toB64, unwrapKey, wrapKey, type MessagePayload,
} from '../crypto/e2e';
import type { LocalDb, LocalMessage } from '../db/local';
import { bus } from '../state/events';

export interface OutgoingMessage {
  kind: 'text' | 'image' | 'document';
  payload: MessagePayload;
  replyTo?: string | null;
  mentions?: string[];
  fileIds?: string[];
}

interface KeysResponse {
  keyVersion: number;
  minKeyVersion: number;
  wraps: { version: number; wrappedKey: string }[];
}

export function newClientId(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(12))).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

export class OrgEngine {
  private syncing: Promise<void> | null = null;
  private resync = false;
  private flushing: Promise<void> | null = null;
  private receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingReceipts = new Map<string, { readSeq: number; deliveredSeq: number }>();
  private keyRequestsBusy = false;
  stopped = false;

  constructor(
    public readonly orgId: string,
    public readonly db: LocalDb,
    private readonly privateKey: Uint8Array,
    public readonly deviceId: string,
    public readonly userId: string,
  ) {}

  async start() {
    await Promise.all([this.refreshGroups().catch(() => undefined), this.sync().catch(() => undefined)]);
    void this.flushOutbox();
    void this.fulfilKeyRequests();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.receiptTimers.values()) clearTimeout(t);
    await this.db.close().catch(() => undefined);
  }

  /** Realtime nudges from the user's WebSocket. */
  async handleEvent(e: { t: string; groupId?: string }) {
    if (e.t === 'sync') {
      await Promise.all([this.sync(), this.refreshGroups()]).catch(() => undefined);
    } else if (e.t === 'keys' && e.groupId) {
      await this.fulfilKeyRequests();
      await this.retryUndecryptable(e.groupId);
    }
  }

  // ---- keys ---------------------------------------------------------------
  private async fetchKeys(groupId: string): Promise<KeysResponse> {
    const r = await api.get<KeysResponse>(`/v1/groups/${groupId}/keys`);
    for (const w of r.wraps) {
      if (await this.db.getGroupKey(groupId, w.version)) continue;
      try {
        await this.db.putGroupKey(groupId, w.version, toB64(unwrapKey(this.privateKey, w.wrappedKey)));
      } catch {
        /* wrap for an older device key; ignore */
      }
    }
    return r;
  }

  async groupKey(groupId: string, version: number, allowFetch = true): Promise<Uint8Array | null> {
    const k = await this.db.getGroupKey(groupId, version);
    if (k) return fromB64(k);
    if (!allowFetch) return null;
    await this.fetchKeys(groupId).catch(() => undefined);
    const again = await this.db.getGroupKey(groupId, version);
    if (again) return fromB64(again);
    await api.post(`/v1/groups/${groupId}/keys/request`).catch(() => undefined);
    return null;
  }

  /** Returns the key version to encrypt with, creating or rotating the group key when needed. */
  async sendKey(groupId: string): Promise<{ version: number; key: Uint8Array }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.fetchKeys(groupId);
      if (r.keyVersion >= 1 && r.keyVersion >= r.minKeyVersion) {
        const k = await this.db.getGroupKey(groupId, r.keyVersion);
        if (k) return { version: r.keyVersion, key: fromB64(k) };
        await api.post(`/v1/groups/${groupId}/keys/request`).catch(() => undefined);
        throw new ApiError(423, 'history_unlocking');
      }
      try {
        return await this.createKeyVersion(groupId, r.keyVersion + 1);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'key_version_conflict') continue;
        throw e;
      }
    }
    throw new ApiError(409, 'key_version_conflict');
  }

  /** New group key version wrapped for every current member device, every admin device and the org recovery key. */
  private async createKeyVersion(groupId: string, version: number) {
    const rec = await api.get<{ devices: { deviceId: string; publicKey: string }[]; recoveryPublicKey: string | null }>(`/v1/groups/${groupId}/key-recipients`);
    const key = generateSymmetricKey();
    const wraps = rec.devices.map((d) => ({ deviceId: d.deviceId, wrappedKey: wrapKey(fromB64(d.publicKey), key) }));
    if (!wraps.some((w) => w.deviceId === this.deviceId)) throw new ApiError(403, 'device_not_eligible');
    if (rec.recoveryPublicKey) wraps.push({ deviceId: 'recovery', wrappedKey: wrapKey(fromB64(rec.recoveryPublicKey), key) });
    await api.post(`/v1/groups/${groupId}/keys`, { version, wraps });
    await this.db.putGroupKey(groupId, version, toB64(key));
    return { version, key };
  }

  /** Background: wrap keys we hold for new members / new devices ("history is unlocking" on their side). */
  async fulfilKeyRequests() {
    if (this.keyRequestsBusy || this.stopped) return;
    this.keyRequestsBusy = true;
    try {
      const { requests } = await api.get<{ requests: { groupId: string; deviceId: string; publicKey: string; versions: number[] }[] }>('/v1/keys/requests');
      const byGroupVersion = new Map<string, { deviceId: string; wrappedKey: string }[]>();
      for (const r of requests) {
        for (const v of r.versions) {
          const key = await this.groupKey(r.groupId, v, true);
          if (!key) continue;
          const k = `${r.groupId}|${v}`;
          byGroupVersion.set(k, [...(byGroupVersion.get(k) ?? []), { deviceId: r.deviceId, wrappedKey: wrapKey(fromB64(r.publicKey), key) }]);
        }
      }
      for (const [k, wraps] of byGroupVersion) {
        const [groupId, v] = k.split('|');
        await api.post(`/v1/groups/${groupId}/keys`, { version: Number(v), wraps }).catch(() => undefined);
      }
    } catch {
      /* offline; retried on next nudge */
    } finally {
      this.keyRequestsBusy = false;
    }
  }

  // ---- incoming -------------------------------------------------------------
  private async toLocal(m: ServerMessage): Promise<{ local: LocalMessage; ciphertext: string | null }> {
    let payload: MessagePayload | null = null;
    let status: LocalMessage['status'] = 'sent';
    if (m.ciphertext && !m.deletedAt) {
      const key = await this.groupKey(m.groupId, m.keyVersion);
      if (key) {
        try {
          payload = decryptPayload<MessagePayload>(key, m.groupId, m.keyVersion, m.ciphertext);
        } catch {
          status = 'undecryptable';
        }
      } else status = 'undecryptable';
    }
    return {
      local: {
        id: m.id, groupId: m.groupId, seq: m.seq, rev: m.rev, senderId: m.senderId, kind: m.kind, payload, replyTo: m.replyTo,
        mentions: m.mentions, clientId: m.clientId, createdAt: m.createdAt, editedAt: m.editedAt, deletedAt: m.deletedAt,
        archive: m.archive, keyVersion: m.keyVersion, status,
      },
      ciphertext: m.ciphertext,
    };
  }

  async ingest(messages: ServerMessage[]) {
    const groups = new Set<string>();
    for (const m of messages) {
      const { local, ciphertext } = await this.toLocal(m);
      await this.db.upsertMessage(local, ciphertext);
      groups.add(m.groupId);
    }
    if (groups.size) bus.emit('messages', { orgId: this.orgId, groupIds: [...groups] });
    for (const g of groups) {
      const max = Math.max(...messages.filter((m) => m.groupId === g).map((m) => m.seq));
      this.queueReceipt(g, { deliveredSeq: max });
    }
  }

  /** Delta sync: "everything since cursor X". The first sync walks the history; the search banner shows progress. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.resync = false;
        let cursor = Number((await this.db.getMeta('cursor')) ?? 0);
        let hasMore = true;
        while (hasMore && !this.stopped) {
          bus.emit('syncProgress', { orgId: this.orgId, syncing: true, oldestComplete: null });
          const r = await api.get<{ messages: ServerMessage[]; cursor: number; hasMore: boolean }>(`/v1/sync?since=${cursor}&limit=500`);
          await this.ingest(r.messages);
          cursor = r.cursor;
          hasMore = r.hasMore;
          await this.db.setMeta('cursor', String(cursor));
          if (r.messages.length) await this.db.setMeta('syncedUntil', String(r.messages[r.messages.length - 1].createdAt));
        }
        await this.db.setMeta('historyComplete', '1');
        bus.emit('syncProgress', { orgId: this.orgId, syncing: false, oldestComplete: null });
      } while (this.resync && !this.stopped);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Older history for one group (scroll up), e.g. for admins browsing a group they are not a member of. */
  async loadOlder(groupId: string): Promise<boolean> {
    const before = (await this.db.oldestSeq(groupId)) ?? Number.MAX_SAFE_INTEGER;
    if (before <= 1) return false;
    const r = await api.get<{ messages: ServerMessage[]; hasMore: boolean }>(`/v1/groups/${groupId}/messages?before=${before}&limit=50`);
    await this.ingest(r.messages);
    return r.hasMore;
  }

  async retryUndecryptable(groupId?: string) {
    const rows = await this.db.undecryptable(groupId);
    let changed = false;
    for (const r of rows) {
      const key = await this.groupKey(r.groupId, r.keyVersion, false) ?? (await this.groupKey(r.groupId, r.keyVersion, true));
      if (!key) continue;
      const m = await this.db.message(r.id);
      if (!m) continue;
      try {
        m.payload = decryptPayload(key, r.groupId, r.keyVersion, r.ciphertext);
        m.status = 'sent';
        await this.db.upsertMessage(m, null);
        changed = true;
      } catch {
        /* still not decryptable */
      }
    }
    if (changed) bus.emit('messages', { orgId: this.orgId, groupIds: groupId ? [groupId] : [] });
  }

  // ---- group list -------------------------------------------------------------
  async refreshGroups(params: { filter?: string; q?: string; scope?: 'all' } = {}): Promise<GroupSummary[]> {
    const qs = new URLSearchParams({ filter: params.filter ?? 'all', ...(params.q ? { q: params.q } : {}), ...(params.scope ? { scope: params.scope } : {}), limit: '200' });
    const { groups } = await api.get<{ groups: GroupSummary[] }>(`/v1/groups?${qs}`);
    if (!params.q && (params.filter ?? 'all') === 'all' && !params.scope) {
      await this.db.putGroups(groups);
      bus.emit('groups', { orgId: this.orgId });
    }
    return groups;
  }

  /** Decrypted preview of a group's last message (null if not available on this device yet). */
  async preview(g: GroupSummary): Promise<{ text: string; kind: string; senderId: string } | null> {
    const local = await this.db.lastMessage(g.id);
    if (local && local.seq === g.lastSeq) return { text: local.payload?.text ?? local.payload?.files?.[0]?.name ?? '', kind: local.kind, senderId: local.senderId };
    const m = g.lastMessage;
    if (!m || !m.ciphertext) return null;
    const key = await this.groupKey(g.id, m.keyVersion, false);
    if (!key) return null;
    try {
      const p = decryptPayload<MessagePayload>(key, g.id, m.keyVersion, m.ciphertext);
      return { text: p.text ?? p.files?.[0]?.name ?? '', kind: m.kind, senderId: m.senderId };
    } catch {
      return null;
    }
  }

  // ---- outgoing ---------------------------------------------------------------
  async send(groupId: string, msg: OutgoingMessage, clientId = newClientId()): Promise<void> {
    const local: LocalMessage = {
      id: `local:${clientId}`, groupId, seq: 0, rev: 0, senderId: this.userId, kind: msg.kind, payload: msg.payload, replyTo: msg.replyTo ?? null,
      mentions: msg.mentions ?? [], clientId, createdAt: Date.now(), editedAt: null, deletedAt: null, archive: [], keyVersion: 0, status: 'pending',
    };
    await this.db.upsertMessage(local, null);
    await this.db.enqueue(clientId, groupId, msg);
    bus.emit('messages', { orgId: this.orgId, groupIds: [groupId] });
    await this.flushOutbox();
  }

  flushOutbox(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const item of await this.db.outbox()) {
        if (this.stopped) return;
        const msg = JSON.parse(item.body) as OutgoingMessage;
        try {
          for (let i = 0; ; i++) {
            const { version, key } = await this.sendKey(item.groupId);
            try {
              const r = await api.post<{ message: ServerMessage }>(`/v1/groups/${item.groupId}/messages`, {
                clientId: item.clientId, kind: msg.kind, ciphertext: encryptPayload(key, item.groupId, version, msg.payload), keyVersion: version,
                replyTo: msg.replyTo ?? undefined, fileIds: msg.fileIds, mentions: msg.mentions,
              });
              await this.ingest([r.message]);
              await this.db.dequeue(item.clientId);
              break;
            } catch (e) {
              if (e instanceof ApiError && e.code === 'key_rotation_required' && i < 2) continue;
              throw e;
            }
          }
        } catch (e) {
          const err = e as ApiError;
          if (err.status === 0 || err.code === 'history_unlocking') return; // offline: keep queued
          await this.db.bumpAttempt(item.clientId);
          if (err.status >= 400 && err.status < 500 || item.attempts >= 5) {
            await this.db.markFailed(item.clientId); // e.g. removed from the group while writing (§8.7)
            bus.emit('messages', { orgId: this.orgId, groupIds: [item.groupId] });
          }
        }
      }
    })().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async edit(m: LocalMessage, text: string) {
    const { version, key } = await this.sendKey(m.groupId);
    const payload = { ...(m.payload ?? {}), text };
    await api.put(`/v1/messages/${m.id}`, { ciphertext: encryptPayload(key, m.groupId, version, payload), keyVersion: version });
    await this.sync();
  }

  async remove(m: LocalMessage) {
    await api.del(`/v1/messages/${m.id}`);
    await this.sync();
  }

  // ---- receipts ---------------------------------------------------------------
  queueReceipt(groupId: string, r: { readSeq?: number; deliveredSeq?: number }) {
    const cur = this.pendingReceipts.get(groupId) ?? { readSeq: 0, deliveredSeq: 0 };
    this.pendingReceipts.set(groupId, { readSeq: Math.max(cur.readSeq, r.readSeq ?? 0), deliveredSeq: Math.max(cur.deliveredSeq, r.deliveredSeq ?? 0, r.readSeq ?? 0) });
    if (this.receiptTimers.has(groupId)) return;
    this.receiptTimers.set(groupId, setTimeout(() => {
      this.receiptTimers.delete(groupId);
      const body = this.pendingReceipts.get(groupId);
      this.pendingReceipts.delete(groupId);
      if (body && !this.stopped) api.post(`/v1/groups/${groupId}/receipts`, body).catch(() => undefined);
    }, 800));
  }
}
