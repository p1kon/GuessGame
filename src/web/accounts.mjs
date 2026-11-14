import { randomUUID, randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eraseParticipant } from '../service/account-data.mjs';
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const validPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 128;
async function encodePassword(password) {
  const salt = randomBytes(16).toString('hex');
  const value = await derive(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return salt + ':' + value.toString('hex');
}
async function checkPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, expected] = (encoded || '00000000000000000000000000000000:' + '00'.repeat(64)).split(':');
  const value = await derive(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(value, Buffer.from(expected, 'hex'));
}

export class WebAccounts {
  constructor(service, { registrationCode, consentText, source = 'human' }) {
    if (!registrationCode || !consentText) fail('WEB_CONFIG_REQUIRED');
    this.service = service; this.db = service.repository;
    this.registrationCode = registrationCode; this.consentText = consentText; this.source = source;
    this.hashing = 0;
  }
  rate(key, limit = 10, window = 900000) {
    this.db.transaction(() => {
      const now = Date.now();
      this.db.run('DELETE FROM web_rate_limits WHERE window_started<?', now - 86400000);
      const hashed = digest(key);
      const row = this.db.get('SELECT * FROM web_rate_limits WHERE key=?', hashed);
      if (!row || row.window_started < now - window) this.db.run('INSERT OR REPLACE INTO web_rate_limits VALUES (?,?,1)', hashed, now);
      else {
        if (row.count >= limit) fail('RATE_LIMITED');
        this.db.run('UPDATE web_rate_limits SET count=count+1 WHERE key=?', hashed);
      }
    });
  }
  async hashingTask(task) {
    if (this.hashing >= 4) fail('RATE_LIMITED');
    this.hashing++;
    try { return await task(); } finally { this.hashing--; }
  }
  session(accountId) {
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 7 * 86400000;
    this.db.run('DELETE FROM web_sessions WHERE expires_at<?', Date.now());
    this.db.run('INSERT INTO web_sessions VALUES (?,?,?,?)', digest(token), accountId, csrf, expiresAt);
    return { token, csrf, expiresAt };
  }
  async register(input, ip) {
    this.rate('register:' + ip, 5);
    const { username, password, registrationCode, consent } = input;
    if (!same(registrationCode, this.registrationCode)) fail('REGISTRATION_CLOSED');
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || !validPassword(password) || consent !== true) fail('INVALID_REGISTRATION');
    const passwordHash = await this.hashingTask(() => encodePassword(password));
    return this.db.transaction(() => {
      if (this.db.get('SELECT id FROM web_accounts WHERE username_key=?', username.toLowerCase())) fail('USERNAME_TAKEN');
      const id = randomUUID(), participantId = randomUUID(), now = Date.now();
      this.service.createParticipant({ id: participantId, source: this.source, consentVersion: 'web-private-1' });
      this.db.run('INSERT INTO web_accounts VALUES (?,?,?,?,?,?,?,?)', id, username, username.toLowerCase(), passwordHash, participantId, now, this.consentText, now);
      return this.session(id);
    });
  }
  async login({ username, password }, ip) {
    if (typeof username !== 'string' || username.length > 32) fail('INVALID_CREDENTIALS');
    this.rate('login:' + ip, 20);
    this.rate('login-name:' + username.toLowerCase(), 12);
    const account = this.db.get('SELECT * FROM web_accounts WHERE username_key=?', username.toLowerCase());
    const valid = await this.hashingTask(() => checkPassword(password, account?.password_hash));
    if (!valid || !account) fail('INVALID_CREDENTIALS');
    return this.db.transaction(() => {
      if (this.db.get('SELECT password_hash FROM web_accounts WHERE id=?', account.id)?.password_hash !== account.password_hash) fail('INVALID_CREDENTIALS');
      return this.session(account.id);
    });
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length > 100) fail('UNAUTHORIZED');
    const row = this.db.get('SELECT a.*,s.csrf,s.expires_at FROM web_sessions s JOIN web_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?', digest(token), Date.now());
    if (!row) fail('UNAUTHORIZED');
    return { id: row.id, username: row.username, participantId: row.participant_id, csrf: row.csrf,
      telegramId: this.db.get('SELECT telegram_id FROM telegram_users WHERE participant_id=?', row.participant_id)?.telegram_id ?? null };
  }
  logout(token) { this.db.run('DELETE FROM web_sessions WHERE token_hash=?', digest(token || '')); }
  async verifyCurrentPassword(accountId, password) {
    const row = this.db.get('SELECT password_hash FROM web_accounts WHERE id=?', accountId);
    if (!row || !await this.hashingTask(() => checkPassword(password, row.password_hash))) fail('INVALID_CREDENTIALS');
    return row.password_hash;
  }
  async changePassword(accountId, current, password) {
    if (!validPassword(password)) fail('INVALID_PASSWORD');
    const previous = await this.verifyCurrentPassword(accountId, current);
    const encoded = await this.hashingTask(() => encodePassword(password));
    this.db.transaction(() => {
      if (this.db.run('UPDATE web_accounts SET password_hash=? WHERE id=? AND password_hash=?', encoded, accountId, previous).changes !== 1) fail('INVALID_CREDENTIALS');
      this.db.run('DELETE FROM web_sessions WHERE account_id=?', accountId);
    });
  }
  createLink(accountId, telegramId) {
    if (typeof telegramId !== 'string' || !/^[1-9]\d{0,15}$/.test(telegramId) || !Number.isSafeInteger(Number(telegramId))) fail('INVALID_TELEGRAM_ID');
    this.rate('link:' + accountId, 5, 600000);
    return this.db.transaction(() => {
      if (!this.db.get('SELECT id FROM web_accounts WHERE id=?', accountId)) fail('UNAUTHORIZED');
      this.db.run('DELETE FROM web_link_requests WHERE expires_at<? OR account_id=?', Date.now(), accountId);
      const code = randomBytes(18).toString('base64url');
      this.db.run('INSERT INTO web_link_requests VALUES (?,?,?,?,NULL)', digest(code), accountId, telegramId, Date.now() + 600000);
      return { code, expiresIn: 600 };
    });
  }
  inspectLink(telegramId, code) {
    if (typeof code !== 'string' || code.length > 64) fail('LINK_EXPIRED');
    const row = this.db.get('SELECT l.*,a.username,a.participant_id FROM web_link_requests l JOIN web_accounts a ON a.id=l.account_id WHERE l.token_hash=?', digest(code));
    if (!row || row.expires_at < Date.now()) fail('LINK_EXPIRED');
    if (row.telegram_id !== String(telegramId)) fail('LINK_WRONG_USER');
    return row;
  }
  confirmLink(telegramId, code) {
    return this.db.transaction(() => {
      const link = this.inspectLink(telegramId, code);
      const user = this.db.get('SELECT * FROM telegram_users WHERE telegram_id=?', String(telegramId));
      if (!user) fail('TELEGRAM_CONSENT_REQUIRED');
      if (this.service.participant(link.participant_id).source !== this.service.participant(user.participant_id).source) fail('SOURCE_MISMATCH');
      const already = this.db.get('SELECT id FROM web_accounts WHERE participant_id=?', user.participant_id);
      if (already && already.id !== link.account_id) fail('TELEGRAM_ALREADY_LINKED');
      if (link.participant_id !== user.participant_id) {
        const web = this.service.getProgress(link.participant_id), bot = this.service.getProgress(user.participant_id);
        if (web.total && bot.total) fail('TWO_TRAINED_ACCOUNTS');
        const adoptBot = bot.total > 0 || web.total === 0;
        const discarded = adoptBot ? link.participant_id : user.participant_id;
        const losing = adoptBot ? web : bot;
        if (losing.pendingTurn) fail('PENDING_TURN');
        if (adoptBot) this.db.run('UPDATE web_accounts SET participant_id=? WHERE id=?', user.participant_id, link.account_id);
        else this.db.run('UPDATE telegram_users SET participant_id=? WHERE telegram_id=?', link.participant_id, String(telegramId));
        eraseParticipant(this.service, discarded);
      }
      this.db.run('UPDATE web_link_requests SET consumed_at=? WHERE token_hash=?', Date.now(), digest(code));
      return { username: link.username, linked: true };
    });
  }
}
