'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const botId = 999;
const message = (update_id, text, user = 101) => ({ update_id, message: {
  message_id: update_id + 1, chat: { id: user, type: 'private' },
  from: { id: user, is_bot: false }, text,
} });
const callback = (update_id, data, user = 101) => ({ update_id, callback_query: {
  id: 'callback-' + update_id, from: { id: user, is_bot: false }, data,
  message: { message_id: 77, chat: { id: user, type: 'private' }, from: { id: botId, is_bot: true } },
} });
async function setup(t) {
  const { GameService } = await import('../src/service/game-service.mjs');
  const { TelegramAdapter } = await import('../src/telegram/adapter.mjs');
  const service = new GameService(':memory:'); t.after(() => service.close());
  const calls = [];
  const client = { async call(method, payload) {
    calls.push({ method, payload });
    return { message_id: 77, date: Math.floor(Date.now() / 1000) };
  } };
  const adapter = new TelegramAdapter({ service, client, botId,
    allowedUserIds: ['101', '202'], consentText: 'Локальный тест. Храним биты до /delete. Экспорт: /export.',
    consentVersion: 'owner-test-1', participantSource: 'simulated' });
  const last = () => calls.filter(c => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);
  const buttons = () => last().payload.reply_markup?.inline_keyboard.flat() || [];
  const accept = async (user = 101, offset = 0) => {
    await adapter.handle(message(offset + 1, '/start', user));
    const consent = buttons()[0].callback_data;
    await adapter.handle(callback(offset + 2, consent, user));
  };
  return { service, adapter, client, calls, last, buttons, accept, TelegramAdapter };
}
test('consent, committed prediction, callbacks and duplicate updates', async t => {
  const { service, adapter, calls, buttons, accept } = await setup(t);
  await accept();
  await adapter.handle(callback(3, buttons().find(b => b.text.includes('Видимый')).callback_data));
  await adapter.handle(callback(4, buttons()[0].callback_data));
  const answer = buttons()[1].callback_data;
  const participant = service.repository.get('SELECT participant_id FROM telegram_users WHERE telegram_id=?', '101').participant_id;
  assert.equal(service.getProgress(participant).total, 0);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  await adapter.handle(callback(5, answer));
  const count = calls.length;
  await adapter.handle(callback(5, answer));
  assert.equal(calls.length, count);
  const reordered = callback(5, answer);
  await adapter.handle({ callback_query: reordered.callback_query, update_id: reordered.update_id });
  assert.equal(calls.length, count);
  assert.equal(service.getProgress(participant).total, 1);
  for (const call of calls) {
    for (const row of call.payload.reply_markup?.inline_keyboard || []) {
      for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    }
  }
});
test('private allowlist, forged callbacks and missing consent cannot change a model', async t => {
  const { service, adapter, accept, buttons } = await setup(t);
  await adapter.handle(message(1, '/start', 303));
  await adapter.handle(callback(2, 'g:s:v'));
  assert.equal(service.repository.get('SELECT count(*) AS n FROM participants').n, 0);
  await accept(101, 10);
  await adapter.handle(callback(13, 'g:s:v'));
  await adapter.handle(callback(14, buttons()[0].callback_data));
  const stolen = buttons()[0].callback_data;
  await accept(202, 20);
  await adapter.handle(callback(23, stolen, 202));
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns WHERE actual_bit IS NOT NULL').n, 0);
  const group = message(30, '/start'); group.message.chat.type = 'group';
  await adapter.handle(group);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM participants').n, 2);
});
test('blind mode hides prediction until answer; network retry does not duplicate a turn', async t => {
  const { service, adapter, client, buttons, accept, last } = await setup(t);
  await accept();
  await adapter.handle(callback(3, 'g:s:b'));
  const guess = buttons()[0].callback_data;
  const original = client.call;
  client.call = async (method, payload) => {
    if (method === 'editMessageText') throw new Error('NETWORK');
    return original(method, payload);
  };
  await assert.rejects(adapter.handle(callback(4, guess)), /NETWORK/);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  client.call = original;
  await adapter.handle(callback(4, guess));
  assert.match(last().payload.text, /скрыт/i);
  assert.doesNotMatch(last().payload.text, /P\(1\)/);
  const answer = buttons()[0].callback_data;
  await adapter.handle(message(6, '/export'));
  assert.match(last().payload.text, /Сначала завершите/);
  await adapter.handle(callback(5, answer));
  assert.match(last().payload.text, /Модель:/);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
});
test('export and confirmed deletion remove only the authenticated player', async t => {
  const { service, adapter, calls, accept, buttons } = await setup(t);
  await accept(); await accept(202, 10);
  const { PredictorEngine } = await import('../src/core/index.mjs');
  const historical = new PredictorEngine();
  historical.update(1, historical.predict(1700000000000), { source: 'simulated', answeredAt: 1700000001000 });
  const participant = service.repository.get('SELECT participant_id FROM telegram_users WHERE telegram_id=?', '101').participant_id;
  service.importHistory(participant, historical.exportState(), { source: 'simulated' });
  await adapter.handle(message(20, '/export'));
  const document = calls.find(c => c.method === 'sendDocument');
  assert.ok(document);
  const exported = JSON.parse(document.payload.documentText);
  assert.equal(exported.format, 'GuessGameParticipantExport');
  assert.ok(exported.historyImport);
  assert.equal(exported.state.total, 1);
  assert.equal(JSON.stringify(exported).includes('telegram_id'), false);
  await adapter.handle(message(21, '/delete'));
  assert.equal(service.repository.get('SELECT count(*) AS n FROM participants').n, 2);
  const confirmation = buttons()[0].callback_data;
  await adapter.handle(callback(22, confirmation));
  assert.equal(service.repository.get('SELECT count(*) AS n FROM participants').n, 1);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM telegram_users WHERE telegram_id=?', '101').n, 0);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM history_imports').n, 0);
  await adapter.handle(callback(22, confirmation));
  assert.equal(service.repository.get('SELECT count(*) AS n FROM participants').n, 1);
});

test('durable outgoing actions survive adapter restart without repeating model operations', async t => {
  const { service, adapter, client, buttons, accept, TelegramAdapter, calls } = await setup(t);
  await accept();
  await adapter.handle(callback(3, 'g:s:v'));
  const guess = buttons()[0].callback_data;
  const original = client.call;
  client.call = async () => { throw new Error('NETWORK'); };
  await assert.rejects(adapter.handle(callback(4, guess)), /NETWORK/);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  const restarted = new TelegramAdapter({ service, client: { call: original }, botId,
    allowedUserIds: ['101'], consentText: 'Локальный тест. Храним биты до /delete. Экспорт: /export.',
    consentVersion: 'owner-test-1', participantSource: 'simulated' });
  await restarted.drain();
  assert.equal(restarted.getOffset(), 5);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  assert.equal(service.repository.get("SELECT count(*) AS n FROM telegram_deliveries WHERE status='accepted'").n, 1);
  const count = calls.length;
  await restarted.handle(callback(4, guess));
  assert.equal(calls.length, count);
});

test('outbox insert failure rolls back the model command; concurrent duplicates are serialized', async t => {
  const { service, adapter, buttons, accept } = await setup(t);
  await accept(); await adapter.handle(callback(3, 'g:s:v'));
  const guess = buttons()[0].callback_data;
  service.repository.db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON telegram_updates
    WHEN NEW.update_id=4 BEGIN SELECT RAISE(ABORT, 'outbox failure'); END`);
  await assert.rejects(adapter.handle(callback(4, guess)), /outbox failure/);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 0);
  service.repository.db.exec('DROP TRIGGER fail_outbox');
  await Promise.all([adapter.handle(callback(4, guess)), adapter.handle(callback(4, guess))]);
  assert.equal(service.repository.get('SELECT count(*) AS n FROM turns').n, 1);
  await assert.rejects(adapter.handle(callback(4, 'g:s:b')), /UPDATE_CONFLICT/);
});

test('Telegram requires an explicit button confirmation to link a web account', async t => {
  const { service, adapter, accept, buttons, last } = await setup(t);
  const { WebAccounts } = await import('../src/web/accounts.mjs');
  const accounts = new WebAccounts(service, { registrationCode: 'synthetic-code', consentText: 'Synthetic', source: 'simulated' });
  adapter.webAccounts = accounts;
  await accept();
  const web = await accounts.register({ username: 'browser_owner', password: 'synthetic-long-password', registrationCode: 'synthetic-code', consent: true }, '127.0.0.1');
  const account = accounts.authenticate(web.token);
  const link = accounts.createLink(account.id, '101');
  await adapter.handle(message(3, '/link ' + link.code));
  assert.match(last().payload.text, /browser_owner/);
  assert.equal(accounts.authenticate(web.token).telegramId, null);
  await adapter.handle(callback(4, buttons()[0].callback_data));
  assert.equal(accounts.authenticate(web.token).telegramId, '101');
  assert.match(last().payload.text, /История и модель общие/);
  await adapter.handle(message(5, '/delete'));
  await adapter.handle(callback(6, buttons()[0].callback_data));
  assert.throws(() => accounts.authenticate(web.token), /UNAUTHORIZED/);
});
