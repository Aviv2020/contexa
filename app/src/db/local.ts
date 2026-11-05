/**
 * Local-first store (§7.7): an encrypted SQLite database (SQLCipher) per organisation, so a remote disconnect
 * wipes only that org's data (§3.5). Holds decrypted messages, the group list cache, unwrapped group keys,
 * the offline outbox and an FTS5 index for on-device search (§4.5).
 */
import * as SQLite from 'expo-sqlite';
import type { ArchiveMark, GroupSummary } from '../api/types';
import type { MessagePayload } from '../crypto/e2e';

export interface LocalMessage {
  id: string;
  groupId: string;
  seq: number;
  rev: number;
  senderId: string;
  kind: 'text' | 'image' | 'document';
  payload: MessagePayload | null;
  replyTo: string | null;
  mentions: string[];
  clientId: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  archive: ArchiveMark[];
  keyVersion: number;
  status: 'sent' | 'pending' | 'failed' | 'undecryptable';
}

interface Row {
  id: string;
  group_id: string;
  seq: number;
  rev: number;
  sender_id: string;
  kind: LocalMessage['kind'];
  payload: string | null;
  reply_to: string | null;
  mentions: string | null;
  client_id: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  archive: string | null;
  key_version: number;
  status: LocalMessage['status'];
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, seq INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, sender_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT, ciphertext TEXT, reply_to TEXT, mentions TEXT, client_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, archive TEXT, key_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, group_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT NOT NULL, last_activity_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_keys (group_id TEXT NOT NULL, version INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (group_id, version));
CREATE TABLE IF NOT EXISTS outbox (client_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media_cache (key TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, last_used INTEGER NOT NULL);
`;

export class LocalDb {
  private constructor(public readonly orgId: string, private db: SQLite.SQLiteDatabase) {}

  static fileName(orgId: string) {
    return `contexa-${orgId.replace(/[^\w-]/g, '')}.db`;
  }

  static async open(orgId: string, key: string): Promise<LocalDb> {
    const db = await SQLite.openDatabaseAsync(LocalDb.fileName(orgId));
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync(SCHEMA);
    return new LocalDb(orgId, db);
  }

  static async destroy(orgId: string): Promise<void> {
    await SQLite.deleteDatabaseAsync(LocalDb.fileName(orgId)).catch(() => undefined);
  }

  async close() {
    await this.db.closeAsync();
  }

  // ---- meta -------------------------------------------------------------
  async getMeta(k: string): Promise<string | null> {
    const r = await this.db.getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k = ?', k);
    return r?.v ?? null;
  }
  async setMeta(k: string, v: string) {
    await this.db.runAsync('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // ---- group keys (stored unwrapped, inside the encrypted DB) -------------
  async getGroupKey(groupId: string, version: number): Promise<string | null> {
    const r = await this.db.getFirstAsync<{ key: string }>('SELECT key FROM group_keys WHERE group_id = ? AND version = ?', groupId, version);
    return r?.key ?? null;
  }
  async putGroupKey(groupId: string, version: number, key: string) {
    await this.db.runAsync('INSERT OR REPLACE INTO group_keys (group_id, version, key) VALUES (?,?,?)', groupId, version, key);
  }
  async groupKeyVersions(groupId: string): Promise<number[]> {
    const rows = await this.db.getAllAsync<{ version: number }>('SELECT version FROM group_keys WHERE group_id = ? ORDER BY version', groupId);
    return rows.map((r) => r.version);
  }
  async dropGroup(groupId: string) {
    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync('DELETE FROM messages WHERE group_id = ?', groupId);
      await this.db.runAsync('DELETE FROM messages_fts WHERE group_id = ?', groupId);
      await this.db.runAsync('DELETE FROM group_keys WHERE group_id = ?', groupId);
      await this.db.runAsync('DELETE FROM outbox WHERE group_id = ?', groupId);
      await this.db.runAsync('DELETE FROM groups WHERE id = ?', groupId);
    });
  }

  // ---- groups cache -------------------------------------------------------
  async putGroups(groups: GroupSummary[]) {
    await this.db.withTransactionAsync(async () => {
      for (const g of groups) await this.db.runAsync('INSERT OR REPLACE INTO groups (id, data, last_activity_at) VALUES (?,?,?)', g.id, JSON.stringify(g), g.lastActivityAt);
    });
  }
  async listGroups(): Promise<GroupSummary[]> {
    const rows = await this.db.getAllAsync<{ data: string }>('SELECT data FROM groups ORDER BY last_activity_at DESC');
    return rows.map((r) => JSON.parse(r.data));
  }

  // ---- messages ---------------------------------------------------------
  async upsertMessage(m: LocalMessage, ciphertext: string | null) {
    await this.db.withTransactionAsync(async () => {
      // A server echo replaces the optimistic local copy (same client id).
      await this.db.runAsync("DELETE FROM messages WHERE client_id = ? AND id != ?", m.clientId, m.id);
      await this.db.runAsync(
        `INSERT INTO messages (id, group_id, seq, rev, sender_id, kind, payload, ciphertext, reply_to, mentions, client_id, created_at, edited_at, deleted_at, archive, key_version, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, rev = excluded.rev, payload = excluded.payload, ciphertext = excluded.ciphertext, edited_at = excluded.edited_at,
           deleted_at = excluded.deleted_at, archive = excluded.archive, key_version = excluded.key_version, status = excluded.status`,
        m.id, m.groupId, m.seq, m.rev, m.senderId, m.kind, m.payload ? JSON.stringify(m.payload) : null, m.status === 'undecryptable' ? ciphertext : null,
        m.replyTo, JSON.stringify(m.mentions), m.clientId, m.createdAt, m.editedAt, m.deletedAt, JSON.stringify(m.archive), m.keyVersion, m.status,
      );
      await this.db.runAsync('DELETE FROM messages_fts WHERE message_id = ?', m.id);
      const text = [m.payload?.text, ...(m.payload?.files ?? []).map((f) => f.name)].filter(Boolean).join(' ');
      if (text && !m.deletedAt) await this.db.runAsync('INSERT INTO messages_fts (text, message_id, group_id) VALUES (?,?,?)', text, m.id, m.groupId);
    });
  }

  async undecryptable(groupId?: string): Promise<{ id: string; groupId: string; keyVersion: number; ciphertext: string }[]> {
    return this.db.getAllAsync(
      `SELECT id, group_id AS groupId, key_version AS keyVersion, ciphertext FROM messages WHERE status = 'undecryptable' AND ciphertext IS NOT NULL ${groupId ? 'AND group_id = ?' : ''} LIMIT 500`,
      ...(groupId ? [groupId] : []),
    );
  }

  async messages(groupId: string, limit = 50, beforeSeq = Number.MAX_SAFE_INTEGER): Promise<LocalMessage[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM messages WHERE group_id = ? AND (seq < ? OR status = 'pending' OR status = 'failed') ORDER BY CASE WHEN status IN ('pending','failed') THEN 1 ELSE 0 END DESC, seq DESC, created_at DESC LIMIT ?`,
      groupId, beforeSeq, limit,
    );
    return rows.map(toLocal);
  }

  async message(id: string): Promise<LocalMessage | null> {
    const r = await this.db.getFirstAsync<Row>('SELECT * FROM messages WHERE id = ?', id);
    return r ? toLocal(r) : null;
  }

  async oldestSeq(groupId: string): Promise<number | null> {
    const r = await this.db.getFirstAsync<{ s: number | null }>("SELECT MIN(seq) AS s FROM messages WHERE group_id = ? AND status != 'pending'", groupId);
    return r?.s ?? null;
  }

  async lastMessage(groupId: string): Promise<LocalMessage | null> {
    const r = await this.db.getFirstAsync<Row>('SELECT * FROM messages WHERE group_id = ? ORDER BY seq DESC LIMIT 1', groupId);
    return r ? toLocal(r) : null;
  }

  /** Full-text search over decrypted messages, on the device only. */
  async search(q: { text?: string; groupId?: string; kind?: 'image' | 'document'; savedOnly?: boolean; senderId?: string; from?: number; to?: number }): Promise<LocalMessage[]> {
    const where: string[] = ['m.deleted_at IS NULL'];
    const args: (string | number)[] = [];
    let join = '';
    if (q.text?.trim()) {
      join = 'JOIN messages_fts f ON f.message_id = m.id';
      where.push('messages_fts MATCH ?');
      args.push(
        q.text.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, '""')}"*`).join(' '),
      );
    }
    if (q.groupId) (where.push('m.group_id = ?'), args.push(q.groupId));
    if (q.kind) (where.push('m.kind = ?'), args.push(q.kind));
    if (q.savedOnly) where.push("m.archive IS NOT NULL AND m.archive != '[]'");
    if (q.senderId) (where.push('m.sender_id = ?'), args.push(q.senderId));
    if (q.from) (where.push('m.created_at >= ?'), args.push(q.from));
    if (q.to) (where.push('m.created_at <= ?'), args.push(q.to));
    const rows = await this.db.getAllAsync<Row>(`SELECT m.* FROM messages m ${join} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 200`, ...args);
    return rows.map(toLocal);
  }

  // ---- outbox (offline writes, §6.2) --------------------------------------
  async enqueue(clientId: string, groupId: string, body: unknown) {
    await this.db.runAsync('INSERT OR REPLACE INTO outbox (client_id, group_id, body, created_at) VALUES (?,?,?,?)', clientId, groupId, JSON.stringify(body), Date.now());
  }
  async outbox(): Promise<{ clientId: string; groupId: string; body: string; attempts: number }[]> {
    return this.db.getAllAsync('SELECT client_id AS clientId, group_id AS groupId, body, attempts FROM outbox ORDER BY created_at');
  }
  async dequeue(clientId: string) {
    await this.db.runAsync('DELETE FROM outbox WHERE client_id = ?', clientId);
  }
  async bumpAttempt(clientId: string) {
    await this.db.runAsync('UPDATE outbox SET attempts = attempts + 1 WHERE client_id = ?', clientId);
  }
  async markFailed(clientId: string) {
    await this.db.runAsync("UPDATE messages SET status = 'failed' WHERE client_id = ?", clientId);
    await this.dequeue(clientId);
  }

  // ---- encrypted media cache (LRU, quota per org) -------------------------
  async mediaGet(key: string): Promise<string | null> {
    const r = await this.db.getFirstAsync<{ path: string }>('SELECT path FROM media_cache WHERE key = ?', key);
    if (r) await this.db.runAsync('UPDATE media_cache SET last_used = ? WHERE key = ?', Date.now(), key);
    return r?.path ?? null;
  }
  async mediaPut(key: string, path: string, size: number) {
    await this.db.runAsync('INSERT OR REPLACE INTO media_cache (key, path, size, last_used) VALUES (?,?,?,?)', key, path, size, Date.now());
  }
  /** Returns paths to evict so the cache fits in `quotaBytes`. */
  async mediaEvict(quotaBytes: number): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ key: string; path: string; size: number }>('SELECT key, path, size FROM media_cache ORDER BY last_used DESC');
    let total = 0;
    const evict: string[] = [];
    for (const r of rows) {
      total += r.size;
      if (total > quotaBytes) {
        evict.push(r.path);
        await this.db.runAsync('DELETE FROM media_cache WHERE key = ?', r.key);
      }
    }
    return evict;
  }
}

function toLocal(r: Row): LocalMessage {
  return {
    id: r.id,
    groupId: r.group_id,
    seq: r.seq,
    rev: r.rev,
    senderId: r.sender_id,
    kind: r.kind,
    payload: r.payload ? JSON.parse(r.payload) : null,
    replyTo: r.reply_to,
    mentions: r.mentions ? JSON.parse(r.mentions) : [],
    clientId: r.client_id,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    archive: r.archive ? JSON.parse(r.archive) : [],
    keyVersion: r.key_version,
    status: r.status,
  };
}
