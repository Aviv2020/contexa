-- Central identity database (spec §3.5): a phone number is the global identity.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,          -- E.164
  name TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'he',
  created_at INTEGER NOT NULL
);

CREATE TABLE system_admins (user_id TEXT PRIMARY KEY REFERENCES users(id));

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'standalone' CHECK (mode IN ('standalone','connected')),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  recovery_public_key TEXT,            -- org recovery key (public half only, §6.5)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  job_title TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','deactivated')),
  managed_by TEXT,                     -- plugin name when provisioned via SCIM (phase B)
  invite_expires_at INTEGER,
  last_active_month TEXT,              -- billing: YYYY-MM of last activity
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,            -- X25519 public key, base64
  platform TEXT NOT NULL DEFAULT 'unknown',
  name TEXT NOT NULL DEFAULT '',
  push_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- Per-org remote revocation: wipes only that org's data on the device (§3.5)
CREATE TABLE org_device_revocations (
  org_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, device_id)
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_refresh_device ON refresh_tokens(device_id);
