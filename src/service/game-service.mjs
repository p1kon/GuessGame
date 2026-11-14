import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PredictorEngine, restoreState, APP_VERSION, validBit } from '../core/index.mjs';
import { SqliteRepository } from './sqlite-repository.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const algorithmChecksum = hash(readFileSync(new URL('../core/predictor.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const fail = code => { throw new Error(code); };
const identifier = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('INVALID_ID');
  return value;
};
const eventHash = row => hash(JSON.stringify([row.id, row.participant_id, row.session_id,
  row.seq, row.predicted_at, row.snapshot_json, row.actual_bit, row.answered_at]));
function decodeState(json) {
  const raw = JSON.parse(json);
  if (raw.algorithmVersion !== APP_VERSION) fail('ALGORITHM_MISMATCH');
  const state = restoreState(raw);
  // These are checksummed snapshots from this service, not legacy imports.
  // restoreState normalizes imported weights; doing that on every database read
  // introduces floating-point drift compared with uninterrupted engine updates.
  state.weights = { ...raw.weights };
  return state;
}

function learnRecordedTurn(engine, row, training, recordedForecast, source) {
  const correct = engine.state.correct;
  engine.update(row.actual_bit, training, { answeredAt: row.answered_at,
    source: source === 'human' ? 'live' : 'simulated' });
  // The updated model uses probabilities recomputed on the prepended history.
  // Scores and response-model feedback retain the forecast actually shown.
  const original = JSON.parse(row.snapshot_json);
  engine.state.predictions[engine.state.total - 1] = original.guess;
  engine.state.lastPrediction = original.guess;
  engine.state.correct = correct + Number(original.guess === row.actual_bit);
  engine.state.forecastLog[engine.state.total - 1] = recordedForecast;
}

// Internal synchronous application boundary. A future adapter MUST authenticate
// callers before supplying participantId; possession of an ID is not authentication.
export class GameService {
  constructor(file, { clock = Date.now } = {}) {
    this.repository = new SqliteRepository(file);
    this.clock = clock;
  }
  close() { this.repository.close(); }
  now() {
    const at = this.clock();
    if (!Number.isSafeInteger(at) || at < 0) fail('INVALID_TIME');
    return at;
  }
  participant(id) {
    identifier(id);
    return this.repository.get('SELECT * FROM participants WHERE id=?', id) || fail('NOT_FOUND');
  }
  command(id, requestId, payload, action) {
    identifier(requestId);
    return this.repository.transaction(() => {
      this.participant(id);
      const fingerprint = hash(JSON.stringify(payload));
      const receipt = this.repository.get('SELECT * FROM receipts WHERE participant_id=? AND request_id=?', id, requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        return JSON.parse(receipt.response_json);
      }
      const result = action();
      this.repository.run('INSERT INTO receipts VALUES (?,?,?,?)', id, requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  createParticipant({ id, source = 'simulated', consentVersion = null }) {
    identifier(id);
    if (!['human', 'simulated'].includes(source)) fail('INVALID_SOURCE');
    if (source === 'human') identifier(consentVersion);
    return this.repository.transaction(() => {
      const existing = this.repository.get('SELECT * FROM participants WHERE id=?', id);
      if (existing) {
        if (existing.source !== source || existing.consent_version !== consentVersion) fail('PARTICIPANT_CONFLICT');
        return { id, source };
      }
      const at = this.now();
      const engine = new PredictorEngine(); engine.state.startedAt = at;
      const json = JSON.stringify(engine.exportState());
      this.repository.run('INSERT INTO participants(id,source,created_at,initial_json,initial_checksum,consent_version) VALUES (?,?,?,?,?,?)',
        id, source, at, json, hash(json), consentVersion);
      this.repository.run('INSERT INTO predictor_snapshots VALUES (?,?,?,?)', id, 0, json, hash(json));
      return { id, source };
    });
  }
  startSession(id, { requestId, visibility = 'visible', goal = null, protocolVersion = 'local-prototype-1' }) {
    if (!['visible', 'blind'].includes(visibility)) fail('INVALID_VISIBILITY');
    if (goal !== null && (typeof goal !== 'string' || goal.length > 1000)) fail('INVALID_GOAL');
    identifier(protocolVersion);
    return this.command(id, requestId, ['session', visibility, goal, protocolVersion], () => {
      if (this.repository.get('SELECT id FROM turns WHERE participant_id=? AND actual_bit IS NULL', id)) fail('PENDING_TURN');
      const at = this.now();
      this.repository.run('UPDATE sessions SET ended_at=? WHERE participant_id=? AND ended_at IS NULL', at, id);
      const session = { id: randomUUID(), participantId: id, startedAt: at, visibility, goal,
        protocolVersion, algorithmVersion: APP_VERSION, algorithmChecksum };
      this.repository.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)', session.id, id, at, null,
        visibility, goal, protocolVersion, APP_VERSION, algorithmChecksum);
      return session;
    });
  }
  session(id, sessionId) {
    const session = this.repository.get('SELECT * FROM sessions WHERE id=? AND participant_id=?', sessionId, id);
    if (!session) fail('NOT_FOUND');
    if (session.algorithm_version !== APP_VERSION || session.algorithm_checksum !== algorithmChecksum) fail('ALGORITHM_MISMATCH');
    return session;
  }
  endSession(id, { sessionId, requestId }) {
    identifier(sessionId);
    return this.command(id, requestId, ['end-session', sessionId], () => {
      const session = this.session(id, sessionId);
      if (this.repository.get('SELECT id FROM turns WHERE session_id=? AND actual_bit IS NULL', sessionId)) fail('PENDING_TURN');
      const endedAt = session.ended_at ?? this.now();
      this.repository.run('UPDATE sessions SET ended_at=? WHERE id=?', endedAt, sessionId);
      return { sessionId, endedAt };
    });
  }
  engine(id) {
    const participant = this.participant(id);
    const snapshot = this.repository.get('SELECT * FROM predictor_snapshots WHERE participant_id=? AND revision=?', id, participant.revision);
    if (!snapshot || hash(snapshot.state_json) !== snapshot.checksum) fail('CORRUPT_STATE');
    try {
      const engine = new PredictorEngine(decodeState(snapshot.state_json));
      if (engine.state.total !== participant.revision || engine.state.algorithmVersion !== APP_VERSION) fail('CORRUPT_STATE');
      return engine;
    } catch { fail('CORRUPT_STATE'); }
  }
  getState(id) {
    // Administrative API: full state must never be sent to a blind-mode player.
    return this.repository.transaction(() => this.engine(id).exportState());
  }
  getProgress(id) {
    return this.repository.transaction(() => {
      const engine = this.engine(id);
      const pending = this.repository.get('SELECT * FROM turns WHERE participant_id=? AND actual_bit IS NULL', id);
      if (pending) this.verifyEvent(pending);
      return { total: engine.state.total, correct: engine.state.correct,
        pendingTurn: pending ? this.view(pending, this.session(id, pending.session_id)) : null };
    });
  }
  view(row, session) {
    const snapshot = JSON.parse(row.snapshot_json);
    const reveal = session.visibility === 'visible' || row.actual_bit !== null;
    return { id: row.id, sessionId: row.session_id, seq: row.seq, predictedAt: row.predicted_at,
      prediction: reveal ? snapshot.guess : null, p1: reveal ? snapshot.prob1 : null,
      visibility: session.visibility, actualBit: row.actual_bit, answeredAt: row.answered_at,
      hit: row.actual_bit === null ? null : row.actual_bit === snapshot.guess,
      algorithmVersion: session.algorithm_version, source: this.participant(row.participant_id).source };
  }
  verifyEvent(row) { if (eventHash(row) !== row.event_checksum) fail('CORRUPT_EVENT'); }
  predict(id, { sessionId, requestId }) {
    identifier(sessionId);
    return this.command(id, requestId, ['predict', sessionId], () => {
      const session = this.session(id, sessionId);
      if (session.ended_at !== null) fail('SESSION_CLOSED');
      const pending = this.repository.get('SELECT * FROM turns WHERE participant_id=? AND actual_bit IS NULL', id);
      if (pending) { this.verifyEvent(pending); return this.view(pending, session); }
      const engine = this.engine(id);
      const at = this.now();
      const previous = engine.state.moveTimes.at(-1);
      if (previous != null && at < previous) fail('CLOCK_REGRESSION');
      const snapshot = engine.predict(at, session.visibility === 'visible');
      const row = { id: randomUUID(), participant_id: id, session_id: sessionId,
        seq: engine.state.total + 1, predicted_at: at, snapshot_json: JSON.stringify(snapshot),
        actual_bit: null, answered_at: null };
      this.repository.run('INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?)', row.id, id, sessionId,
        row.seq, at, row.snapshot_json, null, null, eventHash(row));
      return this.view(row, session);
    });
  }
  answer(id, { turnId, bit, requestId }) {
    identifier(turnId);
    if (!validBit(bit)) fail('INVALID_BIT');
    return this.command(id, requestId, ['answer', turnId, bit], () => {
      const row = this.repository.get('SELECT * FROM turns WHERE id=? AND participant_id=?', turnId, id);
      if (!row) fail('NOT_FOUND');
      this.verifyEvent(row);
      const session = this.session(id, row.session_id);
      if (row.actual_bit !== null) {
        if (row.actual_bit !== bit) fail('TURN_FINALIZED');
        return this.view(row, session);
      }
      if (session.ended_at !== null) fail('SESSION_CLOSED');
      const engine = this.engine(id);
      const snapshot = JSON.parse(row.snapshot_json);
      if (row.seq !== engine.state.total + 1) fail('REVISION_CONFLICT');
      row.actual_bit = bit; row.answered_at = this.now();
      if (row.answered_at < row.predicted_at) fail('CLOCK_REGRESSION');
      engine.update(bit, snapshot, { answeredAt: row.answered_at,
        source: this.participant(id).source === 'human' ? 'live' : 'simulated' });
      this.repository.run('UPDATE turns SET actual_bit=?,answered_at=?,event_checksum=? WHERE id=?', bit, row.answered_at, eventHash(row), row.id);
      const json = JSON.stringify(engine.exportState());
      this.repository.run('INSERT INTO predictor_snapshots VALUES (?,?,?,?)', id, row.seq, json, hash(json));
      this.repository.run('UPDATE participants SET revision=? WHERE id=?', row.seq, id);
      return this.view(row, session);
    });
  }
  recover(id) {
    return this.repository.transaction(() => {
      const participant = this.participant(id);
      const engine = this.replayEngine(id);
      const old = this.repository.get('SELECT * FROM predictor_snapshots WHERE participant_id=? AND revision=?', id, participant.revision);
      this.repository.run('INSERT INTO recovery_audit(participant_id,recovered_at,revision,previous_json,previous_checksum) VALUES (?,?,?,?,?)',
        id, this.now(), participant.revision, old?.state_json ?? null, old?.checksum ?? null);
      const json = JSON.stringify(engine.exportState());
      this.repository.run('INSERT OR REPLACE INTO predictor_snapshots VALUES (?,?,?,?)', id, participant.revision, json, hash(json));
      return engine.exportState();
    });
  }
  replayEngine(id) {
    const participant = this.participant(id);
    if (hash(participant.initial_json) !== participant.initial_checksum) fail('CORRUPT_STATE');
    const engine = new PredictorEngine(decodeState(participant.initial_json));
    const rows = this.repository.all('SELECT * FROM turns WHERE participant_id=? ORDER BY seq', id);
    for (const row of rows) {
      this.verifyEvent(row);
      const session = this.session(id, row.session_id);
      const training = this.repository.get('SELECT * FROM turn_training_snapshots WHERE turn_id=?', row.id);
      const computed = engine.predict(row.predicted_at, session.visibility === 'visible');
      if (training) {
        if (row.actual_bit === null || hash(training.snapshot_json) !== training.snapshot_checksum ||
            hash(training.recorded_forecast_json) !== training.recorded_checksum ||
            JSON.stringify(computed) !== training.snapshot_json) fail('CORRUPT_TRAINING_SNAPSHOT');
        learnRecordedTurn(engine, row, computed, JSON.parse(training.recorded_forecast_json), participant.source);
      } else {
        if (row.seq !== engine.state.total + 1 || JSON.stringify(computed) !== row.snapshot_json) fail('CORRUPT_EVENT');
        if (row.actual_bit === null) continue;
        engine.update(row.actual_bit, computed, { answeredAt: row.answered_at,
          source: participant.source === 'human' ? 'live' : 'simulated' });
      }
    }
    if (engine.state.total !== participant.revision) fail('REVISION_CONFLICT');
    return engine;
  }
  importHistory(id, raw, { source = 'human' } = {}) {
    const sourceJson = JSON.stringify(raw);
    const checksum = hash(sourceJson);
    return this.repository.transaction(() => {
      const participant = this.participant(id);
      if (participant.source !== source) fail('SOURCE_MISMATCH');
      const prior = this.repository.get('SELECT * FROM history_imports WHERE participant_id=?', id);
      if (prior) {
        if (prior.source_checksum !== checksum) fail('HISTORY_ALREADY_IMPORTED');
        return JSON.parse(prior.result_json);
      }
      const lease = this.repository.get("SELECT value FROM telegram_meta WHERE key='polling_lease'");
      if (lease && JSON.parse(lease.value).expires > Date.now()) fail('BOT_IS_RUNNING');
      const rows = this.repository.all('SELECT * FROM turns WHERE participant_id=? ORDER BY seq', id);
      if (rows.some(row => row.actual_bit === null)) fail('PENDING_TURN');
      const before = this.engine(id).exportState();
      if (JSON.stringify(this.replayEngine(id).exportState()) !== JSON.stringify(before)) fail('STATE_EVENT_MISMATCH');
      const engine = new PredictorEngine(restoreState(raw));
      if (!engine.state.total || engine.state.total !== engine.state.history.length) fail('EMPTY_HISTORY');
      if (rows.length !== before.total) fail('UNSUPPORTED_INITIAL_HISTORY');
      if (rows.length && engine.state.moveTimes.some(at => at !== null && at > rows[0].predicted_at)) fail('HISTORY_TIME_OVERLAP');
      const baseline = JSON.stringify(engine.exportState());
      const importedTurns = engine.state.total;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const original = JSON.parse(row.snapshot_json);
        const training = engine.predict(row.predicted_at, original.visible);
        const trainingJson = JSON.stringify(training);
        const recorded = JSON.stringify(before.forecastLog[i]);
        this.repository.run('INSERT INTO turn_training_snapshots VALUES (?,?,?,?,?,?)',
          row.id, trainingJson, hash(trainingJson), recorded, hash(recorded), 'replay');
        learnRecordedTurn(engine, row, training, JSON.parse(recorded), source);
      }
      const result = { importedTurns, preservedTurns: rows.length, total: engine.state.total,
        correct: engine.state.correct, sourceChecksum: checksum };
      const beforeJson = JSON.stringify(before);
      this.repository.run('INSERT INTO history_imports VALUES (?,?,?,?,?,?,?,?,?,?)', id, this.now(), source,
        sourceJson, checksum, participant.initial_json, participant.initial_checksum,
        beforeJson, hash(beforeJson), JSON.stringify(result));
      this.repository.run('UPDATE participants SET initial_json=?,initial_checksum=?,revision=? WHERE id=?',
        baseline, hash(baseline), engine.state.total, id);
      const json = JSON.stringify(engine.exportState());
      this.repository.run('INSERT INTO predictor_snapshots VALUES (?,?,?,?)', id, engine.state.total, json, hash(json));
      if (JSON.stringify(this.replayEngine(id).exportState()) !== json) fail('IMPORT_REPLAY_MISMATCH');
      return result;
    });
  }
}
