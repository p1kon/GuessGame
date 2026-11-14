'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function setup(t) {
  const { GameService } = await import('../src/service/game-service.mjs');
  const { WebAccounts } = await import('../src/web/accounts.mjs');
  const service = new GameService(':memory:'); t.after(() => service.close());
  const accounts = new WebAccounts(service, { registrationCode: 'private-test-code', consentText: 'Synthetic test consent', source: 'simulated' });
  const register = username => accounts.register({ username, password: 'example-long-password', registrationCode: 'private-test-code', consent: true }, '127.0.0.1');
  return { service, accounts, register };
}
test('password hashes, session authentication, case-insensitive login and logout', async t => {
  const { service, accounts, register } = await setup(t);
  const session = await register('Alice');
  const stored = service.repository.get('SELECT password_hash FROM web_accounts');
  assert.equal(stored.password_hash.includes('example-long-password'), false);
  assert.equal(accounts.authenticate(session.token).username, 'Alice');
  await assert.rejects(accounts.login({ username: 'ALICE', password: 'wrong-password' }, '127.0.0.1'), /INVALID_CREDENTIALS/);
  const again = await accounts.login({ username: 'alice', password: 'example-long-password' }, '127.0.0.1');
  assert.ok(again.token !== session.token);
  accounts.logout(again.token);
  assert.throws(() => accounts.authenticate(again.token), /UNAUTHORIZED/);
  await assert.rejects(accounts.register({ username: 'bob', password: 'example-long-password', registrationCode: 'bad', consent: true }, '127.0.0.1'), /REGISTRATION_CLOSED/);
  const id = accounts.authenticate(session.token).id;
  await accounts.changePassword(id, 'example-long-password', 'changed-long-password');
  assert.throws(() => accounts.authenticate(session.token), /UNAUTHORIZED/);
  assert.ok((await accounts.login({ username: 'alice', password: 'changed-long-password' }, '127.0.0.1')).token);
});
test('Telegram linking adopts existing trained model only after the authenticated bot confirms', async t => {
  const { service: s, accounts, register } = await setup(t);
  const session = await register('owner');
  const account = accounts.authenticate(session.token);
  s.createParticipant({ id: 'telegram-player', source: 'simulated' });
  s.repository.run('INSERT INTO telegram_users(telegram_id,participant_id,consent_hash,consent_at) VALUES (?,?,?,?)', '101', 'telegram-player', 'synthetic', Date.now());
  const game = s.startSession('telegram-player', { requestId: 's' });
  const turn = s.predict('telegram-player', { sessionId: game.id, requestId: 'p' });
  s.answer('telegram-player', { turnId: turn.id, bit: 1, requestId: 'a' });
  const before = s.getState('telegram-player');
  const link = accounts.createLink(account.id, '101');
  assert.notEqual(accounts.authenticate(session.token).participantId, 'telegram-player');
  assert.throws(() => accounts.confirmLink('202', link.code), /LINK_WRONG_USER/);
  accounts.confirmLink('101', link.code);
  assert.equal(accounts.authenticate(session.token).participantId, 'telegram-player');
  assert.deepEqual(s.getState('telegram-player'), before);
  assert.equal(s.repository.get('SELECT count(*) AS n FROM participants').n, 1);
  assert.deepEqual(s.recover('telegram-player'), before);
  const other = await register('another');
  const stolen = accounts.createLink(accounts.authenticate(other.token).id, '101');
  assert.throws(() => accounts.confirmLink('101', stolen.code), /TELEGRAM_ALREADY_LINKED/);
});
test('linking two nonempty histories fails without losing either history', async t => {
  const { service: s, accounts, register } = await setup(t);
  const account = accounts.authenticate((await register('alice')).token);
  s.createParticipant({ id: 'bot', source: 'simulated' });
  s.repository.run('INSERT INTO telegram_users(telegram_id,participant_id,consent_hash,consent_at) VALUES (?,?,?,?)', '101', 'bot', 'test', Date.now());
  for (const id of [account.participantId, 'bot']) {
    const session = s.startSession(id, { requestId: 's' });
    const turn = s.predict(id, { sessionId: session.id, requestId: 'p' });
    s.answer(id, { turnId: turn.id, bit: 1, requestId: 'a' });
  }
  const link = accounts.createLink(account.id, '101');
  assert.throws(() => accounts.confirmLink('101', link.code), /TWO_TRAINED_ACCOUNTS/);
  assert.equal(s.getState('bot').total, 1);
  assert.equal(s.getState(account.participantId).total, 1);
});
