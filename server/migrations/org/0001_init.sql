-- Organisation data. Every table is scoped by org_id.
CREATE TABLE org_settings (
  org_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,              -- JSON, see src/lib/settings.ts
  rev INTEGER NOT NULL DEFAULT 0       -- org-wide monotonic change counter for delta sync
);

CREATE TABLE context_types (
  org_id TEXT PRIMARY KEY,             -- phase A: one context type per org (§2.2)
  label TEXT NOT NULL,                 -- e.g. "מטופל"
  label_plural TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'person',
  header_fields TEXT NOT NULL DEFAULT '[]'  -- JSON [{key,label}]
);

CREATE TABLE contexts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  external_id TEXT,
  name TEXT NOT NULL,
  display_id TEXT NOT NULL DEFAULT '',
  photo_key TEXT,
  header TEXT NOT NULL DEFAULT '{}',   -- JSON {key: value}; display fields only (§5.5)
  managed_by TEXT,
  archived_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, external_id)
);
CREATE INDEX idx_contexts_org ON contexts(org_id, archived_at);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  context_id TEXT NOT NULL UNIQUE REFERENCES contexts(id),
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  last_message_id TEXT,
  key_version INTEGER NOT NULL DEFAULT 0,       -- latest group key version created by a client
  min_key_version INTEGER NOT NULL DEFAULT 1,   -- bumped when a member is removed: senders must rotate
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_groups_org_activity ON groups(org_id, last_activity_at DESC);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(org_id, user_id, removed_at);

CREATE TABLE group_user_state (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,       -- ms epoch; -1 = forever
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  last_delivered_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);

-- Group key wrapped per recipient device (or 'recovery' for the org recovery key). Server holds wraps only.
CREATE TABLE group_keys (
  group_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrapped_by_device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, version, device_id)
);
CREATE INDEX idx_group_keys_device ON group_keys(device_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','document')),
  size INTEGER NOT NULL,               -- size of the original, encrypted bytes
  variants TEXT NOT NULL,              -- JSON list of uploaded variants: thumb, preview, original
  created_at INTEGER NOT NULL,
  purged_at INTEGER
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','image','document')),
  ciphertext TEXT,                     -- AES-256-GCM under the group key; NULL once deleted
  key_version INTEGER NOT NULL,
  reply_to TEXT,
  file_ids TEXT,                       -- JSON array
  mentions TEXT,                       -- JSON array of user ids (metadata, used for push)
  client_id TEXT NOT NULL,             -- idempotency key from the device (offline outbox)
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  UNIQUE (group_id, seq),
  UNIQUE (group_id, client_id)
);
CREATE INDEX idx_messages_rev ON messages(org_id, rev);
CREATE INDEX idx_messages_group_seq ON messages(group_id, seq);

CREATE TABLE doc_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Context archive (§4.3.3). The file stays encrypted as in chat.
CREATE TABLE archive_docs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  file_id TEXT NOT NULL UNIQUE,        -- a file can be saved once
  message_id TEXT NOT NULL,
  doc_type_id TEXT NOT NULL,
  description_ct TEXT,                 -- encrypted under group key
  key_version INTEGER,
  doc_date TEXT NOT NULL,              -- YYYY-MM-DD
  saved_by TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by TEXT,
  external_ref TEXT,                   -- phase B: id/link in the core system
  status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('pending','saved','failed','removed'))
);
CREATE INDEX idx_archive_context ON archive_docs(context_id, saved_at DESC);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT,
  at INTEGER NOT NULL,
  actor_user_id TEXT,
  actor_device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_org_at ON audit_log(org_id, at DESC);
