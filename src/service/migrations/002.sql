CREATE TABLE telegram_consent_documents (
  hash TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE telegram_users (
  telegram_id TEXT PRIMARY KEY,
  participant_id TEXT UNIQUE NOT NULL REFERENCES participants(id),
  consent_hash TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  delete_token TEXT
);
CREATE TABLE telegram_prompts (
  telegram_id TEXT PRIMARY KEY,
  consent_hash TEXT NOT NULL,
  prompted_at INTEGER NOT NULL
);
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  user_id TEXT,
  payload_hash TEXT,
  actions_json TEXT NOT NULL,
  next_action INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  erase_identity INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE telegram_deliveries (
  update_id INTEGER NOT NULL,
  action_index INTEGER NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL CHECK(kind IN ('prediction','feedback')),
  recorded_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','rejected')),
  message_id INTEGER,
  error_code INTEGER,
  PRIMARY KEY(update_id, action_index)
);
CREATE TABLE telegram_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version=2;
