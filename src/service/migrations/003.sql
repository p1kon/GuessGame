CREATE TABLE history_imports (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  imported_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('human','simulated')),
  source_json TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  previous_initial_json TEXT NOT NULL,
  previous_initial_checksum TEXT NOT NULL,
  previous_state_json TEXT NOT NULL,
  previous_state_checksum TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE TABLE turn_training_snapshots (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id),
  snapshot_json TEXT NOT NULL,
  snapshot_checksum TEXT NOT NULL,
  recorded_forecast_json TEXT NOT NULL,
  recorded_checksum TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin='replay')
);
PRAGMA user_version=3;
