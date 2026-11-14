'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function setup() {
  const { GameService } = await import('../src/service/game-service.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-service-'));
  const file = path.join(directory, 'test.sqlite');
  const service = new GameService(file);
  service.createParticipant({ id: 'alice', source: 'simulated' });
  service.createParticipant({ id: 'bob', source: 'simulated' });
  return { service, file, GameService };
}
test('committed prediction, repeat delivery, conflicting answers and player isolation', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 'session', visibility: 'visible' });
  const beforeBob = s.getState('bob');
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'guess' });
  assert.equal(s.getState('alice').total, 0);
  assert.deepEqual(s.predict('alice', { sessionId: session.id, requestId: 'guess' }), turn);
  assert.equal(s.predict('alice', { sessionId: session.id, requestId: 'guess-again' }).id, turn.id);
  assert.throws(() => s.answer('bob', { turnId: turn.id, bit: 1, requestId: 'stolen' }), /NOT_FOUND/);
  const result = s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'answer' });
  assert.deepEqual(s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'answer' }), result);
  assert.deepEqual(s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'another-answer' }), result);
  assert.throws(() => s.answer('alice', { turnId: turn.id, bit: 0, requestId: 'conflict' }), /TURN_FINALIZED/);
  assert.throws(() => s.answer('alice', { turnId: turn.id, bit: 0, requestId: 'answer' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(s.getState('alice').total, 1);
  assert.deepEqual(s.getState('bob'), beforeBob);
  // Delayed retry must return the original turn, not start a new one.
  assert.deepEqual(s.predict('alice', { sessionId: session.id, requestId: 'guess' }), turn);
});
test('blind pending prediction survives restart and is not disclosed', async t => {
  const { service: s, file, GameService } = await setup();
  const session = s.startSession('alice', { requestId: 's', visibility: 'blind' });
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' });
  assert.equal(turn.prediction, null); assert.equal(turn.p1, null);
  assert.equal(turn.snapshot, undefined);
  assert.equal(s.getProgress('alice').pendingTurn.prediction, null);
  assert.throws(() => s.startSession('alice', { requestId: 's2' }), /PENDING_TURN/);
  s.close();
  const reopened = new GameService(file); t.after(() => reopened.close());
  assert.deepEqual(reopened.predict('alice', { sessionId: session.id, requestId: 'p' }), turn);
  const completed = reopened.answer('alice', { turnId: turn.id, bit: 0, requestId: 'a' });
  assert.ok(completed.prediction === 0 || completed.prediction === 1);
  assert.equal(reopened.getState('alice').total, 1);
});
test('database failure rolls back answer, state and dedupe receipt; retry succeeds', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 's' });
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' });
  s.repository.db.exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON predictor_snapshots
    WHEN NEW.revision > 0 BEGIN SELECT RAISE(ABORT, 'forced storage failure'); END`);
  assert.throws(() => s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'a' }), /forced storage failure/);
  assert.equal(s.getState('alice').total, 0);
  assert.equal(s.repository.db.prepare('SELECT actual_bit FROM turns WHERE id=?').get(turn.id).actual_bit, null);
  s.repository.db.exec('DROP TRIGGER fail_snapshot');
  s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'a' });
  assert.equal(s.getState('alice').total, 1);
});

test('failure before prediction receipt commits exposes no pending turn', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 's' });
  s.repository.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts
    WHEN NEW.request_id='p' BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END`);
  assert.throws(() => s.predict('alice', { sessionId: session.id, requestId: 'p' }), /forced receipt failure/);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM turns').n, 0);
  assert.equal(s.getProgress('alice').pendingTurn, null);
  s.repository.db.exec('DROP TRIGGER fail_receipt');
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' });
  assert.equal(turn.seq, 1);
});
test('corrupt snapshot fails closed, explicit event recovery preserves exact forecasts', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 's' });
  for (let i = 0; i < 20; i++) {
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    s.answer('alice', { turnId: turn.id, bit: i % 2, requestId: 'a' + i });
  }
  const before = s.getState('alice');
  s.repository.db.prepare("UPDATE predictor_snapshots SET state_json='broken' WHERE participant_id=? AND revision=20").run('alice');
  assert.throws(() => s.getState('alice'), /CORRUPT_STATE/);
  assert.deepEqual(s.recover('alice'), before);
  assert.deepEqual(s.getState('alice'), before);
  assert.equal(s.repository.get('SELECT previous_json FROM recovery_audit WHERE participant_id=?', 'alice').previous_json, 'broken');
  s.repository.db.prepare('UPDATE turns SET actual_bit=1-actual_bit WHERE participant_id=? AND seq=1').run('alice');
  assert.throws(() => s.recover('alice'), /CORRUPT_EVENT/);
});

test('session lifecycle, validation and stable participant provenance', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  assert.throws(() => s.createParticipant({ id: 'alice', source: 'human', consentVersion: 'v1' }), /PARTICIPANT_CONFLICT/);
  assert.throws(() => s.createParticipant({ id: 'human', source: 'human' }), /INVALID_ID/);
  const session = s.startSession('alice', { requestId: 's' });
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' });
  assert.throws(() => s.answer('alice', { turnId: turn.id, bit: '1', requestId: 'bad' }), /INVALID_BIT/);
  assert.throws(() => s.endSession('alice', { sessionId: session.id, requestId: 'end' }), /PENDING_TURN/);
  s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'a' });
  const closed = s.endSession('alice', { sessionId: session.id, requestId: 'end' });
  assert.deepEqual(s.endSession('alice', { sessionId: session.id, requestId: 'end' }), closed);
  assert.throws(() => s.predict('alice', { sessionId: session.id, requestId: 'new' }), /SESSION_CLOSED/);
  const next = s.startSession('alice', { requestId: 's2', visibility: 'blind' });
  assert.notEqual(next.id, session.id);
  assert.equal(s.getProgress('alice').total, 1);
  s.repository.run("UPDATE sessions SET algorithm_checksum='wrong' WHERE id=?", next.id);
  assert.throws(() => s.predict('alice', { sessionId: next.id, requestId: 'bad-version' }), /ALGORITHM_MISMATCH/);
});

test('service persistence is exactly equivalent to uninterrupted core across sessions', async t => {
  const { service: s } = await setup(); t.after(() => s.close());
  const { PredictorEngine } = await import('../src/core/index.mjs');
  const direct = new PredictorEngine();
  direct.state.startedAt = s.getState('alice').startedAt;
  let at = 1800000000000;
  s.clock = () => at;
  let session;
  for (let i = 0; i < 100; i++) {
    if (i % 25 === 0) {
      at += 600000;
      session = s.startSession('alice', { requestId: 's' + i });
    }
    at += 5000;
    const prediction = direct.predict(at, true);
    const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' + i });
    assert.equal(turn.prediction, prediction.guess);
    assert.equal(turn.p1, prediction.prob1);
    const bit = (i + Math.floor(i / 7)) % 2;
    at += 1000;
    direct.update(bit, prediction, { answeredAt: at, source: 'simulated' });
    s.answer('alice', { turnId: turn.id, bit, requestId: 'a' + i });
    assert.deepEqual(s.getState('alice'), direct.exportState());
  }
  assert.deepEqual(s.recover('alice'), direct.exportState());
});

async function race(file, jobs) {
  const { Worker } = require('node:worker_threads');
  const gate = new SharedArrayBuffer(4);
  const ready = [], results = [];
  for (const job of jobs) {
    let readyResolve;
    ready.push(new Promise(resolve => { readyResolve = resolve; }));
    results.push(new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'helpers/service-worker.mjs'),
        { workerData: { file, gate, ...job } });
      let result;
      worker.on('message', message => {
        if (message.ready) readyResolve(); else result = message;
      });
      worker.on('error', reject);
      worker.on('exit', code => {
        readyResolve();
        if (code !== 0) reject(new Error('Worker exited: ' + code));
        else resolve(result);
      });
    }));
  }
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, jobs.length);
  return Promise.all(results);
}

test('independent concurrent connections create one prediction and accept one answer', async t => {
  const { service: s, file } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 's' });
  const predictions = await race(file, [0, 1, 2].map(i => ({ operation: 'predict',
    input: { sessionId: session.id, requestId: 'p' + i } })));
  assert.ok(predictions.every(row => row.result?.id === predictions[0].result?.id));
  const turnId = predictions[0].result.id;
  const answers = await race(file, [0, 1, 0, 1].map((bit, i) => ({
    input: { turnId, bit, requestId: 'a' + i } })));
  const accepted = answers.filter(row => row.result);
  assert.ok(accepted.length > 0);
  assert.ok(accepted.every(row => row.result.actualBit === accepted[0].result.actualBit));
  assert.ok(answers.filter(row => row.error).every(row => row.error === 'TURN_FINALIZED'));
  assert.equal(s.getState('alice').total, 1);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  assert.deepEqual(s.recover('alice'), s.getState('alice'));
});

test('abrupt worker exit during a transaction leaves the pending turn intact', async t => {
  const { Worker } = require('node:worker_threads');
  const { service: s, file } = await setup(); t.after(() => s.close());
  const session = s.startSession('alice', { requestId: 's' });
  const turn = s.predict('alice', { sessionId: session.id, requestId: 'p' });
  const worker = new Worker(path.join(__dirname, 'helpers/service-worker.mjs'),
    { workerData: { file, crash: true, turnId: turn.id } });
  const code = await new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  assert.equal(code, 23);
  assert.equal(s.getState('alice').total, 0);
  assert.equal(s.repository.get('SELECT actual_bit FROM turns WHERE id=?', turn.id).actual_bit, null);
  s.answer('alice', { turnId: turn.id, bit: 1, requestId: 'a' });
  assert.equal(s.getState('alice').total, 1);
});
