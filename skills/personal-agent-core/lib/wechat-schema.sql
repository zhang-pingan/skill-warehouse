CREATE TABLE IF NOT EXISTS main_session_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','ready')),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS wechat_channel (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  owner_id TEXT,
  cursor TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  binding_version INTEGER,
  start_seq INTEGER NOT NULL DEFAULT -1,
  observed_seq INTEGER NOT NULL DEFAULT -1,
  delivery_state_json TEXT NOT NULL DEFAULT '{"current":null}',
  restore_hold INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS wechat_contacts (
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY(account_id,peer_id)
) STRICT;
CREATE TABLE IF NOT EXISTS wechat_inbox (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','held','failed','command','completed')),
  error TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,peer_id,external_id)
) STRICT;
CREATE TABLE IF NOT EXISTS wechat_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  source_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  segment INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','unknown','waiting','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS wechat_outbox_pending ON wechat_outbox(generation,state,sequence);

CREATE TABLE IF NOT EXISTS wechat_interactions (
  interaction_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('question','approval')),
  details_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','answered','settled','expired','interrupted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
