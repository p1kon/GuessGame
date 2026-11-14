CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('human','simulated')),
  created_at INTEGER NOT NULL,
  initial_json TEXT NOT NULL,
  initial_checksum TEXT NOT NULL,
  consent_version TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  visibility TEXT NOT NULL CHECK(visibility IN ('visible','blind')),
  goal TEXT,
  protocol_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  algorithm_checksum TEXT NOT NULL
);
CREATE UNIQUE INDEX active_session ON sessions(participant_id) WHERE ended_at IS NULL;
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  predicted_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  actual_bit INTEGER CHECK(actual_bit IN (0,1)),
  answered_at INTEGER,
  event_checksum TEXT NOT NULL,
  UNIQUE(participant_id, seq),
  CHECK((actual_bit IS NULL) = (answered_at IS NULL))
);
CREATE UNIQUE INDEX pending_turn ON turns(participant_id) WHERE actual_bit IS NULL;
CREATE TABLE predictor_snapshots (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  PRIMARY KEY(participant_id, revision)
);
CREATE TABLE receipts (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  PRIMARY KEY(participant_id, request_id)
);
CREATE TABLE recovery_audit (
  id INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  recovered_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  previous_json TEXT,
  previous_checksum TEXT
);
PRAGMA user_version=1;
