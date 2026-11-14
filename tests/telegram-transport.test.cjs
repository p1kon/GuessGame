'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const token = '123456:' + 'a'.repeat(30);

test('Telegram client sanitizes secrets, respects API retry hints and uploads JSON as multipart', async () => {
  const { TelegramClient } = await import('../src/telegram/client.mjs');
  const leaking = new TelegramClient(token, { fetchImpl: async url => { throw new Error(url); } });
  await assert.rejects(leaking.call('getMe'), error => {
    assert.equal(error.message, 'TELEGRAM_NETWORK_ERROR');
    assert.equal(error.stack.includes(token), false); return true;
  });
  const throttled = new TelegramClient(token, { fetchImpl: async () => ({ ok: false, status: 429,
    json: async () => ({ ok: false, error_code: 429, description: token, parameters: { retry_after: 9 } }) }) });
  await assert.rejects(throttled.call('sendMessage', {}), error => error.retryAfter === 9 && !error.message.includes(token));
  const uploaded = [];
  const client = new TelegramClient(token, { fetchImpl: async (url, options) => {
    uploaded.push(options);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  await client.call('sendDocument', { chat_id: 101, documentText: '{"synthetic":true}', filename: 'export.json' });
  assert.equal(uploaded[0].body.get('chat_id'), '101');
  assert.equal(await uploaded[0].body.get('document').text(), '{"synthetic":true}');
  assert.equal(uploaded[0].redirect, 'error');
});

test('config refuses empty access list and consent, never prints a token in validation errors', async () => {
  const { loadTelegramConfig } = await import('../src/telegram/config.mjs');
  assert.throws(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: token }), /ALLOWED_USER_IDS/);
  assert.throws(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: '101' }), /CONSENT/);
  const config = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: '101,202',
    TELEGRAM_CONSENT_TEXT: 'Synthetic self-test', TELEGRAM_CONSENT_VERSION: 'test-1' });
  assert.deepEqual(config.allowedUserIds, ['101', '202']);
});

test('polling advances durable offset only after delivery and drains before fetching', async () => {
  const { pollOnce } = await import('../src/telegram/polling.mjs');
  let offset = 0; let fail = true;
  const events = [];
  const adapter = {
    async drain() { events.push('drain'); }, getOffset: () => offset,
    async handle(update) { events.push('handle' + update.update_id); if (fail) throw new Error('NETWORK'); },
    confirmOffset(id) { offset = id + 1; },
  };
  const client = { async call(method, payload) {
    events.push('fetch'); assert.equal(payload.offset, offset);
    return [{ update_id: 4 }, { update_id: 5 }];
  } };
  await assert.rejects(pollOnce({ client, adapter }), /NETWORK/);
  assert.equal(offset, 0);
  assert.deepEqual(events, ['drain', 'fetch', 'handle4']);
  fail = false;
  await pollOnce({ client, adapter });
  assert.equal(offset, 6);
});

test('migration from v1 preserves state, nested rollback is atomic and polling lease is exclusive', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { GameService } = await import('../src/service/game-service.mjs');
  const { PollingLease } = await import('../src/telegram/lease.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-migration-'));
  const file = path.join(directory, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(fs.readFileSync(path.join(__dirname, '../src/service/migrations/001.sql'), 'utf8'));
  const { PredictorEngine } = await import('../src/core/index.mjs');
  const { createHash } = require('node:crypto');
  const engine = new PredictorEngine();
  engine.update(1, engine.predict(1700000000000), { answeredAt: 1700000001000, source: 'simulated' });
  const json = JSON.stringify(engine.exportState());
  const checksum = createHash('sha256').update(json).digest('hex');
  old.prepare('INSERT INTO participants(id,source,created_at,initial_json,initial_checksum,revision) VALUES (?,?,?,?,?,?)')
    .run('existing', 'simulated', 1700000000000, json, checksum, 1);
  old.prepare('INSERT INTO predictor_snapshots VALUES (?,?,?,?)').run('existing', 1, json, checksum);
  old.close();
  const game = new GameService(file); t.after(() => game.close());
  assert.equal(game.repository.get('PRAGMA user_version').user_version, 4);
  assert.deepEqual(game.getState('existing'), engine.exportState());
  assert.throws(() => game.repository.transaction(() => {
    game.createParticipant({ id: 'rolled-back', source: 'simulated' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(game.repository.get('SELECT count(*) AS n FROM participants').n, 1);
  let now = 1000;
  const a = new PollingLease(game.repository, { clock: () => now, duration: 100 });
  assert.throws(() => new PollingLease(game.repository, { clock: () => now }), /POLLER_ALREADY_RUNNING/);
  now += 101;
  const b = new PollingLease(game.repository, { clock: () => now });
  assert.throws(() => a.assert(), /POLLING_LEASE_LOST/);
  a.release(); b.assert(); b.release();
});

test('unsent consent prompt is drained from a file database after complete service restart', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { GameService } = await import('../src/service/game-service.mjs');
  const { TelegramAdapter } = await import('../src/telegram/adapter.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-outbox-'));
  const file = path.join(directory, 'transport.sqlite');
  const options = { botId: 999, allowedUserIds: ['101'], consentText: 'Synthetic test consent',
    consentVersion: 'test-1', participantSource: 'simulated' };
  const first = new GameService(file);
  const adapter = new TelegramAdapter({ ...options, service: first,
    client: { call: async () => { throw new Error('NETWORK'); } } });
  await assert.rejects(adapter.handle({ update_id: 1, message: { message_id: 2,
    chat: { id: 101, type: 'private' }, from: { id: 101, is_bot: false }, text: '/start' } }), /NETWORK/);
  first.close();
  const second = new GameService(file);
  try {
    const calls = [];
    const restarted = new TelegramAdapter({ ...options, service: second,
      client: { call: async (method, payload) => { calls.push({ method, payload }); return { message_id: 3 }; } } });
    await restarted.drain();
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /Synthetic test consent/);
    assert.equal(restarted.getOffset(), 2);
    assert.equal(second.repository.get('SELECT count(*) AS n FROM participants').n, 0);
  } finally { second.close(); }
});
