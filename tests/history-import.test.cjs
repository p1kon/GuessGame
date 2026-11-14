'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function setup(t) {
  const { GameService } = await import('../src/service/game-service.mjs');
  const { PredictorEngine } = await import('../src/core/index.mjs');
  let time = 1800000000000;
  const service = new GameService(':memory:', { clock: () => time += 5000 });
  t.after(() => service.close());
  for (const id of ['alice', 'bob']) service.createParticipant({ id, source: 'simulated' });
  const session = service.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 12; i++) {
    const turn = service.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    service.answer('alice', { turnId: turn.id, bit: i % 2, requestId: 'a' + i });
  }
  const engine = new PredictorEngine();
  for (let i = 0; i < 60; i++) {
    const at = 1700000000000 + i * 5000;
    engine.update((i + Math.floor(i / 3)) % 2, engine.predict(at), { source: 'simulated', answeredAt: at + 1000 });
  }
  return { service, history: engine.exportState(), PredictorEngine, session };
}
test('prepend history preserves every recorded Telegram event and score, trains continuation and recovers', async t => {
  const { service: s, history, PredictorEngine, session } = await setup(t);
  const old = s.getState('alice'); const bob = s.getState('bob');
  const events = s.repository.all('SELECT * FROM turns ORDER BY seq');
  const result = s.importHistory('alice', history, { source: 'simulated' });
  assert.equal(result.importedTurns, 60); assert.equal(result.preservedTurns, 12);
  const combined = s.getState('alice');
  assert.equal(combined.total, 72);
  assert.equal(combined.correct, history.correct + old.correct);
  assert.deepEqual(combined.history, history.history.concat(old.history));
  assert.deepEqual(combined.predictions, history.predictions.concat(old.predictions));
  assert.deepEqual(combined.forecastLog.slice(60), old.forecastLog);
  assert.deepEqual(s.repository.all('SELECT * FROM turns ORDER BY seq'), events);
  assert.deepEqual(s.getState('bob'), bob);
  assert.deepEqual(s.recover('alice'), combined);
  const direct = new PredictorEngine(s.engine('alice').state);
  const at = 1900000000000; s.clock = () => at;
  const expected = direct.predict(at);
  const next = s.predict('alice', { sessionId: session.id, requestId: 'next' });
  assert.equal(next.seq, 73); assert.equal(next.p1, expected.prob1);
  s.answer('alice', { turnId: next.id, bit: 1, requestId: 'answer-next' });
  assert.deepEqual(s.recover('alice'), s.getState('alice'));
  assert.deepEqual(s.importHistory('alice', history, { source: 'simulated' }), result);
  assert.equal(s.getState('alice').total, 73);
});
test('import rejects pending turns, wrong source, overlapping time, changed second import, and active bot', async t => {
  const { service: s, history, session } = await setup(t);
  assert.throws(() => s.importHistory('alice', history, { source: 'human' }), /SOURCE_MISMATCH/);
  const future = structuredClone(history); future.moveTimes[0] = 2000000000000;
  assert.throws(() => s.importHistory('alice', future, { source: 'simulated' }), /HISTORY_TIME_OVERLAP/);
  s.repository.run("INSERT INTO telegram_meta VALUES ('polling_lease',?)", JSON.stringify({ owner: 'running', expires: Date.now() + 60000 }));
  assert.throws(() => s.importHistory('alice', history, { source: 'simulated' }), /BOT_IS_RUNNING/);
  s.repository.run("DELETE FROM telegram_meta WHERE key='polling_lease'");
  const pending = s.predict('alice', { sessionId: session.id, requestId: 'pending' });
  assert.throws(() => s.importHistory('alice', history, { source: 'simulated' }), /PENDING_TURN/);
  s.answer('alice', { turnId: pending.id, bit: 0, requestId: 'finish' });
  s.importHistory('alice', history, { source: 'simulated' });
  const other = structuredClone(history); other.startedAt++;
  assert.throws(() => s.importHistory('alice', other, { source: 'simulated' }), /HISTORY_ALREADY_IMPORTED/);
});
test('import rollback retains original model and events if snapshot write fails', async t => {
  const { service: s, history } = await setup(t);
  const before = s.getState('alice');
  s.repository.db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON predictor_snapshots
    WHEN NEW.revision > 12 BEGIN SELECT RAISE(ABORT, 'forced import failure'); END`);
  assert.throws(() => s.importHistory('alice', history, { source: 'simulated' }), /forced import failure/);
  assert.deepEqual(s.getState('alice'), before);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM history_imports').n, 0);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM turn_training_snapshots').n, 0);
  assert.deepEqual(s.recover('alice'), before);
});
test('corrupted replay-training snapshot cannot silently recover', async t => {
  const { service: s, history } = await setup(t);
  s.importHistory('alice', history, { source: 'simulated' });
  s.repository.run("UPDATE turn_training_snapshots SET snapshot_json='broken' WHERE turn_id=(SELECT id FROM turns WHERE seq=1)");
  assert.throws(() => s.recover('alice'), /CORRUPT_TRAINING_SNAPSHOT/);
});
