-- Devices waiting for group-key wraps (new member, new device, re-keyed device). Fulfilled by any
-- online device that already holds the key, in the background ("history is unlocking", §6.5).
CREATE TABLE key_requests (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
CREATE INDEX idx_key_requests_device ON key_requests(device_id);
