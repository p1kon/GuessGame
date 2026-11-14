CREATE TABLE web_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  participant_id TEXT UNIQUE NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  consent_text TEXT NOT NULL,
  consent_at INTEGER NOT NULL
);
CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE web_link_requests (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE web_rate_limits (
  key TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE turn_channels (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id),
  channel TEXT NOT NULL CHECK(channel IN ('web','telegram'))
);
PRAGMA user_version=4;
