'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('at most five snapshots retain exact model and all events across checkpoints and restart', async t => {
  const { GameService } = await import('../src/service/game-service.mjs');
  const { PredictorEngine } = await import('../src/core/index.mjs');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-retention-')), 'test.sqlite');
  let now = 1700000000000;
  let s = new GameService(file, { clock: () => now }); t.after(() => s.close());
  s.createParticipant({ id: 'alice', source: 'simulated' });
  s.createParticipant({ id: 'bob', source: 'simulated' });
  const baseline = new PredictorEngine(); baseline.state.startedAt = now;
  const session = s.startSession('alice', { requestId: 'session' });
  const bob = s.getState('bob');
  for (let i = 0; i < 305; i++) {
    now += 5000;
    const snapshot = baseline.predict(now);
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    assert.equal(turn.p1, snapshot.prob1);
    now += 1000;
    const bit = (i + Math.floor(i / 7)) % 2;
    baseline.update(bit, snapshot, { answeredAt: now, source: 'simulated' });
    s.answer('alice', { turnId: turn.id, bit, requestId: 'a' + i });
    assert.ok(s.repository.get('SELECT count(*) AS n FROM predictor_snapshots WHERE participant_id=?', 'alice').n <= 5);
  }
  assert.deepEqual(s.getState('alice'), baseline.exportState());
  assert.deepEqual(s.recover('alice'), baseline.exportState());
  assert.deepEqual(s.getState('bob'), bob);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM turns WHERE participant_id=?', 'alice').n, 305);
  assert.deepEqual(s.repository.all('SELECT revision FROM predictor_snapshots WHERE participant_id=? ORDER BY revision', 'alice').map(r=>r.revision), [0, 200, 300, 304, 305]);
  const pending = s.predict('alice', { sessionId: session.id, requestId: 'pending-after-checkpoints' });
  s.close(); s = new GameService(file, { clock: () => now });
  assert.equal(s.getProgress('alice').pendingTurn.id, pending.id);
  assert.deepEqual(s.recover('alice'), baseline.exportState());
});

test('maintenance validates every model before pruning, preserves event bytes and is idempotent', async t => {
  const { GameService } = await import('../src/service/game-service.mjs');
  const s = new GameService(':memory:'); t.after(() => s.close());
  s.createParticipant({ id: 'alice', source: 'simulated' });
  const session = s.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 12; i++) {
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    s.answer('alice', { turnId: turn.id, bit: i % 2, requestId: 'a' + i });
  }
  const before = s.getState('alice');
  const events = s.repository.all('SELECT * FROM turns ORDER BY seq');
  // Simulate old redundant rows; no obsolete row is used for learning.
  const latest = s.repository.get('SELECT * FROM predictor_snapshots WHERE participant_id=? AND revision=12', 'alice');
  for (let r = 1; r < 11; r++) s.repository.run('INSERT OR REPLACE INTO predictor_snapshots VALUES (?,?,?,?)', 'alice', r, latest.state_json, latest.checksum);
  const report = s.compactSnapshots();
  assert.equal(report.snapshotsBefore, 13); assert.equal(report.snapshotsAfter, 3);
  assert.ok(report.payloadBytesAfter < report.payloadBytesBefore);
  assert.deepEqual(s.getState('alice'), before);
  assert.deepEqual(s.repository.all('SELECT * FROM turns ORDER BY seq'), events);
  assert.equal(s.compactSnapshots().snapshotsAfter, 3);
  assert.deepEqual(s.recover('alice'), before);
});

test('failure pruning an obsolete snapshot rolls back the whole answer', async t => {
  const { GameService } = await import('../src/service/game-service.mjs');
  const s = new GameService(':memory:'); t.after(() => s.close());
  s.createParticipant({ id: 'alice', source: 'simulated' });
  const session = s.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 2; i++) {
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'a' + i });
  }
  const before = s.getState('alice');
  const pending = s.predict('alice', { sessionId: session.id, requestId: 'next' });
  s.repository.db.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON predictor_snapshots BEGIN SELECT RAISE(ABORT,'forced prune failure'); END");
  assert.throws(() => s.answer('alice', { turnId: pending.id, bit: 0, requestId: 'answer' }), /forced prune failure/);
  assert.deepEqual(s.getState('alice'), before);
  assert.equal(s.repository.get('SELECT actual_bit FROM turns WHERE id=?', pending.id).actual_bit, null);
  s.repository.db.exec('DROP TRIGGER reject_prune');
  s.answer('alice', { turnId: pending.id, bit: 0, requestId: 'answer' });
  assert.equal(s.getState('alice').total, 3);
});

test('a damaged second participant rolls back maintenance for all participants', async t => {
  const { GameService } = await import('../src/service/game-service.mjs');
  const s = new GameService(':memory:'); t.after(() => s.close());
  s.createParticipant({ id: 'alice', source: 'simulated' });
  s.createParticipant({ id: 'bob', source: 'simulated' });
  const session = s.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 3; i++) {
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    s.answer('alice', { turnId: turn.id, bit: i % 2, requestId: 'a' + i });
  }
  const seed = s.repository.get('SELECT * FROM predictor_snapshots WHERE participant_id=? AND revision=3', 'alice');
  s.repository.run('INSERT INTO predictor_snapshots VALUES (?,?,?,?)', 'alice', 1, seed.state_json, seed.checksum);
  s.repository.run("UPDATE predictor_snapshots SET state_json='broken' WHERE participant_id='bob'");
  const before = s.repository.all('SELECT * FROM predictor_snapshots ORDER BY participant_id,revision');
  assert.throws(() => s.compactSnapshots(), /CORRUPT_STATE/);
  assert.deepEqual(s.repository.all('SELECT * FROM predictor_snapshots ORDER BY participant_id,revision'), before);
});

test('maintenance previews a copy, then shrinks the real file without changing facts or model', async () => {
  const { GameService } = await import('../src/service/game-service.mjs');
  const { compactDatabase } = await import('../scripts/compact-database.mjs');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-maintenance-'));
  const file = path.join(root, 'test.sqlite'), backups = path.join(root, 'backups');
  const s = new GameService(file);
  s.createParticipant({ id: 'alice', source: 'simulated' });
  const session = s.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 26; i++) {
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    s.answer('alice', { turnId: turn.id, bit: i % 2, requestId: 'a' + i });
  }
  const before = s.getState('alice');
  const latest = s.repository.get('SELECT * FROM predictor_snapshots WHERE participant_id=? AND revision=26', 'alice');
  for (let r = 1; r < 25; r++) s.repository.run('INSERT INTO predictor_snapshots VALUES (?,?,?,?)', 'alice', r, latest.state_json, latest.checksum);
  s.close();
  const preview = compactDatabase({ databasePath: file, directory: backups });
  assert.equal(preview.applied, false); assert.equal(preview.snapshotsAfter, 3);
  const unchanged = new GameService(file);
  assert.equal(unchanged.repository.get('SELECT count(*) AS n FROM predictor_snapshots').n, 27); unchanged.close();
  const result = compactDatabase({ databasePath: file, directory: backups, apply: true });
  assert.equal(result.factsPreserved, true); assert.equal(result.modelsPreserved, true);
  assert.ok(result.databaseBytesAfter < result.databaseBytesBefore);
  const reopened = new GameService(file);
  try { assert.deepEqual(reopened.getState('alice'), before); assert.deepEqual(reopened.recover('alice'), before); }
  finally { reopened.close(); }
});
