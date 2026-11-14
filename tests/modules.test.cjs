'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./helpers/core.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

test('separate engine instances do not share learning state', async () => {
  const { PredictorEngine } = await import('../src/core/index.mjs');
  const a = new PredictorEngine(), b = new PredictorEngine();
  const before = plain(b.exportState());
  const forecast = plain(b.predict(1700000000000));
  for (let i = 0; i < 80; i++) {
    const at = 1700000000000 + i * 5000;
    a.update(i % 2, a.predict(at), { answeredAt: at + 1000, source: 'simulated' });
  }
  assert.deepEqual(plain(b.exportState()), before);
  assert.deepEqual(plain(b.predict(1700000000000)), forecast);
});

test('native modules match the frozen engine for all aggregators and session gaps', async () => {
  const core = await import('../src/core/index.mjs');
  const frozen = loadCore().api;
  for (const aggregator of ['baseline', 'slow', 'fast', 'multi']) {
    const a = new frozen.PredictorEngine(null, aggregator);
    const b = new core.PredictorEngine(null, aggregator);
    // startedAt is wall-clock metadata, not part of the algorithm.
    b.state.startedAt = a.state.startedAt;
    for (let i = 0; i < 220; i++) {
      const at = 1700000000000 + i * 5000 + Math.floor(i / 70) * 600000;
      const x = a.predict(at, false), y = b.predict(at, false);
      assert.deepEqual(plain(y), plain(x));
      const bit = (i + Math.floor(i / 7)) % 2;
      for (const [engine, snapshot] of [[a, x], [b, y]]) {
        engine.update(bit, snapshot, { answeredAt: at + 1000, source: 'simulated' });
      }
      assert.deepEqual(plain(b.exportState()), plain(a.exportState()));
      assert.deepEqual(plain(b.effectiveWeights()), plain(a.effectiveWeights()));
    }
  }
});

test('module simulator reproduces full frozen runs, including goal changes', async () => {
  const core = await import('../src/core/index.mjs');
  const frozen = loadCore().api;
  for (const aggregator of ['baseline', 'slow', 'fast', 'multi']) {
    const config = { params: { I: .9, S: .7, M: 10, C: .25, Q: .5, E: .6, D: .7, G: -1 },
      turns: 600, sessionSize: 100, initialBit: 0, alternateStart: true, aggregator,
      goalSchedule: [{ at: 201, g: 0 }, { at: 401, g: -1 }] };
    const a = new frozen.SimulationRunner(config), b = new core.SimulationRunner(config);
    while (a.step() !== null) assert.deepEqual(plain(b.step()), plain(a.history.at(-1)));
    assert.equal(b.step(), null);
    assert.deepEqual(plain(b.export()), plain(a.export()));
  }
});

test('modules restore the private history and match 32 subsequent turns', {
  skip: !process.env.GUESSGAME_PRIVATE_STATE,
}, async () => {
  const fs = require('node:fs');
  const core = await import('../src/core/index.mjs');
  const frozen = loadCore().api;
  const raw = JSON.parse(fs.readFileSync(process.env.GUESSGAME_PRIVATE_STATE, 'utf8'));
  const a = new frozen.PredictorEngine(frozen.restoreState(plain(raw)));
  const b = new core.PredictorEngine(core.restoreState(plain(raw)));
  for (let i = 0; i < 32; i++) {
    const at = 1800000000000 + i * 5000;
    const x = a.predict(at), y = b.predict(at);
    assert.deepEqual(plain(y), plain(x));
    for (const [engine, snapshot] of [[a, x], [b, y]]) {
      engine.update(i % 2, snapshot, { answeredAt: at + 1000 });
    }
    assert.deepEqual(plain(b.exportState()), plain(a.exportState()));
  }
});
