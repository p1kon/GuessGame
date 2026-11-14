'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCore } = require('./helpers/core.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const params = { I: .9, S: .7, M: 10, C: .25, Q: .5, E: .6, D: .7, G: -1 };
// All generated histories here are artificial; never export them as participant data.

test('frozen release files retain their exact checksums', () => {
  const manifest = require('../baseline/checksums.json');
  for (const [file, expected] of Object.entries(manifest.files)) {
    const data = fs.readFileSync(path.resolve(__dirname, '..', file));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), expected, file);
  }
});

test('16 experts, four aggregators and the 413/600 reference run', () => {
  const { api } = loadCore();
  assert.equal(api.PREDICTORS.length, 16);
  assert.deepEqual(Object.keys(api.AGGREGATORS), ['baseline', 'slow', 'fast', 'multi']);
  const runner = new api.SimulationRunner({ params, turns: 600, sessionSize: 100,
    initialBit: 0, alternateStart: false, aggregator: 'baseline', goalSchedule: [] });
  while (runner.step() !== null) {}
  assert.equal(runner.summary().n, 600);
  assert.equal(runner.summary().hits, 413);
  assert.equal(runner.summary().sessions, 6);
});

test('prediction precedes learning; stale snapshots cannot add a second turn', () => {
  const { api } = loadCore();
  const engine = new api.PredictorEngine();
  const before = plain(engine.exportState());
  const snapshot = engine.predict(1700000000000, false);
  assert.deepEqual(plain(engine.exportState()), before);
  engine.update(1, snapshot, { answeredAt: 1700000001000, source: 'simulated' });
  const after = plain(engine.exportState());
  assert.throws(() => engine.update(0, snapshot));
  assert.deepEqual(plain(engine.exportState()), after);
});

test('synthetic continuation matches after restore, including a session gap', () => {
  const { api } = loadCore();
  const original = new api.PredictorEngine();
  for (let i = 0; i < 140; i++) {
    const at = 1700000000000 + i * 5000;
    original.update((i * 7 + Math.floor(i / 5)) % 2, original.predict(at),
      { answeredAt: at + 1000, source: 'simulated' });
  }
  const restored = new api.PredictorEngine(api.restoreState(plain(original.exportState())));
  for (let i = 0; i < 32; i++) {
    const at = 1700010000000 + i * 5000;
    const a = original.predict(at), b = restored.predict(at);
    assert.deepEqual(plain(a), plain(b));
    for (const [engine, snapshot] of [[original, a], [restored, b]]) {
      engine.update(i % 2, snapshot, { answeredAt: at + 1000, source: 'simulated' });
    }
    assert.deepEqual(plain(original.exportState()), plain(restored.exportState()));
  }
});

test('storage compaction preserves recorded facts and does not mutate RAM', () => {
  const { api } = loadCore();
  const engine = new api.PredictorEngine();
  for (let i = 0; i < 102; i++) {
    const at = 1700000000000 + i * 5000;
    engine.update(i % 2, engine.predict(at), { answeredAt: at + 1000, source: 'simulated' });
  }
  const full = plain(engine.exportState());
  const before = plain(full);
  const compact = plain(api.compactForStorage(full));
  api.validatePayload(compact);
  assert.deepEqual(full, before);
  assert.deepEqual(compact.history, full.history);
  for (let i = 0; i < 102; i++) {
    const { expertProbs, expertWeights, ...facts } = full.forecastLog[i];
    const { expertProbs: p, expertWeights: w, ...storedFacts } = compact.forecastLog[i];
    assert.deepEqual(storedFacts, facts);
    assert.equal(Boolean(p && w), i % 50 === 0 || i === 101);
  }
});

test('quarantine preserves separate corrupt records; quota failures preserve primary', () => {
  const { api, sandbox, storage } = loadCore();
  const payload = plain(new api.PredictorEngine().exportState());
  storage.set(api.STORAGE_KEY, 'broken-one');
  api.writeWithBackup(payload);
  storage.set(api.STORAGE_KEY, 'broken-two');
  api.writeWithBackup(payload);
  assert.equal(storage.get(api.QUARANTINE_KEY), 'broken-one');
  assert.equal(storage.get(api.QUARANTINE_KEY + '_1'), 'broken-two');
  storage.set(api.STORAGE_KEY, 'broken-three');
  sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => api.writeWithBackup(payload), /QuotaExceededError/);
  assert.equal(storage.get(api.STORAGE_KEY), 'broken-three');
  const healthy = JSON.stringify(payload);
  storage.set(api.STORAGE_KEY, healthy);
  const engine = new api.PredictorEngine();
  engine.update(1, engine.predict(1700000000000), { answeredAt: 1700000001000 });
  assert.throws(() => api.writeWithBackup(engine.exportState()), /QuotaExceededError/);
  assert.equal(storage.get(api.STORAGE_KEY), healthy);
});

test('private historical checkpoint (opt-in; never required by public CI)', {
  skip: !process.env.GUESSGAME_PRIVATE_STATE,
}, () => {
  const { api } = loadCore();
  const raw = JSON.parse(fs.readFileSync(process.env.GUESSGAME_PRIVATE_STATE, 'utf8'));
  const engine = new api.PredictorEngine(api.restoreState(raw));
  assert.equal(engine.state.total, 1200);
  assert.equal(engine.state.correct, 758);
  assert.equal(engine.state.history.length, 1200);
});
