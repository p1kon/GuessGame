import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { eraseParticipant } from '../service/account-data.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const button = (text, callback_data) => ({ text, callback_data });
const menu = [[button('Видимый режим', 'g:s:v'), button('Слепой режим', 'g:s:b')]];
const safeId = value => Number.isSafeInteger(value) && value > 0;
const domainErrors = new Map([
  ['PENDING_TURN', 'Сначала завершите текущий ход. Кнопки можно восстановить командой /resume.'],
  ['TURN_FINALIZED', 'Этот ход уже завершён. Принят первый ответ. Используйте /resume.'],
  ['NOT_FOUND', 'Эта кнопка больше не действует или относится к другому игроку. Используйте /resume.'],
  ['SESSION_CLOSED', 'Сессия завершена. Выберите режим через /start.'],
  ['LINK_EXPIRED', 'Код привязки истёк или неверен. Создайте новый в веб-аккаунте.'],
  ['LINK_WRONG_USER', 'Код выдан для другого Telegram ID. Проверьте ID в веб-аккаунте.'],
  ['TELEGRAM_ALREADY_LINKED', 'Этот Telegram уже привязан к другой веб-учётной записи.'],
  ['TWO_TRAINED_ACCOUNTS', 'У обоих аккаунтов уже есть ходы. Автоматическое объединение заблокировано; обратитесь к владельцу.'],
  ['SOURCE_MISMATCH', 'Нельзя объединить реальные и искусственные данные. Обратитесь к владельцу.'],
  ['TELEGRAM_CONSENT_REQUIRED', 'Сначала подтвердите участие через /start, затем повторите /link с кодом.'],
]);

export class TelegramAdapter {
  constructor({ service, client, botId, allowedUserIds, consentText, consentVersion, participantSource = 'human', assertLease = () => {}, webAccounts = null }) {
    if (!safeId(botId) || !consentText?.trim() || consentText.length > 3000 ||
        !consentVersion?.trim() || consentVersion.length > 100 ||
        !Array.isArray(allowedUserIds) || !allowedUserIds.length ||
        !allowedUserIds.every(id => /^[1-9]\d*$/.test(String(id))) ||
        !['human', 'simulated'].includes(participantSource)) throw new Error('INVALID_TELEGRAM_CONFIG');
    this.service = service; this.db = service.repository; this.client = client;
    this.botId = botId; this.allowed = new Set(allowedUserIds.map(String));
    this.consentText = consentText; this.consentVersion = consentVersion;
    this.consentHash = hash(consentVersion + '\n' + consentText);
    this.participantSource = participantSource;
    this.assertLease = assertLease;
    this.webAccounts = webAccounts;
    this.queue = Promise.resolve();
    this.db.transaction(() => {
      const bot = this.db.get("SELECT value FROM telegram_meta WHERE key='bot_id'");
      if (bot && bot.value !== String(botId)) throw new Error('DATABASE_BELONGS_TO_ANOTHER_BOT');
      this.db.run("INSERT OR IGNORE INTO telegram_meta VALUES ('bot_id',?)", String(botId));
      this.db.run('INSERT OR IGNORE INTO telegram_consent_documents VALUES (?,?,?,?)',
        this.consentHash, consentVersion, consentText, Date.now());
    });
  }
  handle(update) {
    const result = this.queue.then(() => this.process(update));
    this.queue = result.catch(() => {});
    return result;
  }
  context(update) {
    const query = update.callback_query;
    const message = query ? query.message : update.message;
    const from = query ? query.from : message?.from;
    if (!from || !safeId(from.id) || from.is_bot || message?.chat?.type !== 'private' ||
        message.chat.id !== from.id || !safeId(message.message_id) ||
        !this.isAllowed(String(from.id))) return null;
    if (query && (message.from?.id !== this.botId || typeof query.id !== 'string' ||
        typeof query.data !== 'string' || Buffer.byteLength(query.data) > 64)) return null;
    return { userId: String(from.id), chatId: from.id, message, query,
      key: 'tg:' + update.update_id };
  }
  isAllowed(id) {
    return this.allowed.has(String(id)) || Boolean(this.webAccounts && (
      this.db.get('SELECT a.id FROM telegram_users u JOIN web_accounts a ON a.participant_id=u.participant_id WHERE u.telegram_id=?', String(id)) ||
      this.db.get('SELECT token_hash FROM web_link_requests WHERE telegram_id=? AND expires_at>?', String(id), Date.now())));
  }
  response(ctx, text, keyboard = [], extra = {}) {
    return { method: ctx.query ? 'editMessageText' : 'sendMessage', payload: {
      chat_id: ctx.chatId, ...(ctx.query ? { message_id: ctx.message.message_id } : {}),
      text, reply_markup: { inline_keyboard: keyboard },
    }, ...extra };
  }
  consent(ctx) {
    this.db.run('INSERT OR REPLACE INTO telegram_prompts VALUES (?,?,?)', ctx.userId, this.consentHash, Date.now());
    return [this.response(ctx, this.consentText + '\n\nУчастие добровольное. /export — ваши данные; /delete — удалить данные из рабочей базы.',
      [[button('Согласен участвовать', 'g:c:' + this.consentHash.slice(0, 16))]])];
  }
  turn(ctx, turn, kind = 'prediction') {
    const text = turn.actualBit === null ?
      (turn.visibility === 'blind' ? `Ход ${turn.seq}. Прогноз сохранён и скрыт. Какой бит вы выбрали?` :
        `Ход ${turn.seq}. Модель: ${turn.prediction}. P(1) = ${turn.p1.toFixed(3)}. Какой бит вы выбрали?`) :
      `Ход ${turn.seq}. Модель: ${turn.prediction}, ваш бит: ${turn.actualBit}. ${turn.hit ? 'Угадано.' : 'Не угадано.'}`;
    const keyboard = turn.actualBit === null ? [[button('0', 'g:a:' + turn.id + ':0'), button('1', 'g:a:' + turn.id + ':1')]] :
      [[button('Угадай следующий', 'g:p:' + turn.sessionId)]];
    return this.response(ctx, text, keyboard, { turnId: turn.id, kind });
  }
  activeSession(id) {
    return this.db.get('SELECT * FROM sessions WHERE participant_id=? AND ended_at IS NULL', id);
  }
  export(id) {
    const consent = this.db.get('SELECT u.consent_at, d.version, d.text, d.hash FROM telegram_users u JOIN telegram_consent_documents d ON d.hash=u.consent_hash WHERE u.participant_id=?', id);
    return JSON.stringify({ format: 'GuessGameParticipantExport', version: 1,
      exportedAt: Date.now(), participantId: id, consent, state: this.service.getState(id),
      sessions: this.db.all('SELECT * FROM sessions WHERE participant_id=? ORDER BY started_at,id', id),
      turns: this.db.all('SELECT * FROM turns WHERE participant_id=? ORDER BY seq', id),
      historyImport: this.db.get('SELECT imported_at,source,source_checksum,result_json FROM history_imports WHERE participant_id=?', id) ?? null,
      replayTraining: this.db.all('SELECT s.* FROM turn_training_snapshots s JOIN turns t ON t.id=s.turn_id WHERE t.participant_id=? ORDER BY t.seq', id),
      deliveries: this.db.all('SELECT d.* FROM telegram_deliveries d JOIN turns t ON t.id=d.turn_id WHERE t.participant_id=? ORDER BY d.recorded_at', id),
      note: 'Исходные прогнозы сохранены до ответа; accepted означает принятие Telegram API, не прочтение пользователем.',
    }, null, 2);
  }
  erase(user) {
    eraseParticipant(this.service, user.participant_id);
    this.eraseTransport(user.telegram_id);
  }
  eraseTransport(userId) {
    this.db.run('DELETE FROM telegram_prompts WHERE telegram_id=?', userId);
    // Retain only non-identifying update tombstones so stale deliveries cannot
    // restore a deleted participant. Pending exports for this user are removed.
    this.db.run("UPDATE telegram_updates SET user_id=NULL,payload_hash=NULL,actions_json='[]',next_action=0,done=1 WHERE user_id=?", userId);
  }
  plan(ctx) {
    const data = ctx.query?.data;
    const command = ctx.message.text?.trim().split(/\s+/)[0];
    let user = this.db.get('SELECT * FROM telegram_users WHERE telegram_id=?', ctx.userId);
    if (this.webAccounts && (command === '/link' || data?.startsWith('g:l:'))) {
      const code = data?.startsWith('g:l:') ? data.slice(4) : ctx.message.text.trim().split(/\s+/)[1];
      const link = this.webAccounts.inspectLink(ctx.userId, code);
      if (!user || user.consent_hash !== this.consentHash) return this.consent(ctx);
      if (data?.startsWith('g:l:')) {
        this.webAccounts.confirmLink(ctx.userId, code);
        return [this.response(ctx, `Telegram привязан к веб-аккаунту ${link.username}. История и модель общие. Продолжить: /resume.`)];
      }
      return [this.response(ctx, `Привязать ваш Telegram к веб-аккаунту «${link.username}»? Его владелец получит доступ к вашей модели и истории. Подтверждайте только свой аккаунт.`,
        [[button('Подтверждаю привязку', 'g:l:' + code)]])];
    }
    if (data?.startsWith('g:c:')) {
      const prompt = this.db.get('SELECT * FROM telegram_prompts WHERE telegram_id=?', ctx.userId);
      if (data !== 'g:c:' + this.consentHash.slice(0, 16) || prompt?.consent_hash !== this.consentHash) return this.consent(ctx);
      if (!user) {
        const id = randomUUID();
        this.service.createParticipant({ id, source: this.participantSource, consentVersion: this.consentVersion });
        this.db.run('INSERT INTO telegram_users(telegram_id,participant_id,consent_hash,consent_at) VALUES (?,?,?,?)',
          ctx.userId, id, this.consentHash, Date.now());
      } else this.db.run('UPDATE telegram_users SET consent_hash=?,consent_at=? WHERE telegram_id=?', this.consentHash, Date.now(), ctx.userId);
      this.db.run('DELETE FROM telegram_prompts WHERE telegram_id=?', ctx.userId);
      if (this.webAccounts && this.db.get('SELECT token_hash FROM web_link_requests WHERE telegram_id=? AND expires_at>?', ctx.userId, Date.now())) {
        return [this.response(ctx, 'Участие подтверждено. Теперь повторно отправьте команду /link с кодом из веб-аккаунта, чтобы завершить привязку.')];
      }
      return [this.response(ctx, 'Выберите режим. Перед нажатием «Угадай» мысленно выберите 0 или 1.', menu)];
    }
    if (command === '/delete') {
      if (!user) {
        this.eraseTransport(ctx.userId); ctx.eraseIdentity = true;
        return [this.response(ctx, 'Активной игры нет. Служебные данные обращения удалены.')];
      }
      const token = randomBytes(12).toString('hex');
      this.db.run('UPDATE telegram_users SET delete_token=? WHERE telegram_id=?', token, ctx.userId);
      return [this.response(ctx, 'Удалить общий аккаунт, историю и модель из рабочей базы, включая связанную веб-учётную запись? Отменить: /resume.',
        [[button('Подтверждаю удаление', 'g:d:' + token)]])];
    }
    if (data?.startsWith('g:d:')) {
      if (!user?.delete_token || data !== 'g:d:' + user.delete_token) return [this.response(ctx, 'Подтверждение больше не действует.')];
      this.erase(user); ctx.eraseIdentity = true;
      return [this.response(ctx, 'Ваши данные удалены из рабочей базы. Копии сообщений и скачанные файлы в Telegram этим не удаляются.')];
    }
    if (command === '/export' && user) {
      const pending = this.service.getProgress(user.participant_id).pendingTurn;
      if (pending?.visibility === 'blind') return [this.response(ctx,
        'Сначала завершите текущий ход командой /resume: экспорт содержит исходные прогнозы и раскрыл бы скрытый ответ.')];
      const documentText = this.export(user.participant_id);
      if (Buffer.byteLength(documentText) > 10 * 1024 * 1024) return [this.response(ctx, 'Экспорт слишком большой для этого способа. Запросите локальный экспорт у владельца.')];
      return [{ method: 'sendDocument', payload: { chat_id: ctx.chatId, documentText, filename: 'GuessGame_export.json' } }];
    }
    if (!user || user.consent_hash !== this.consentHash) return this.consent(ctx);
    const id = user.participant_id;
    if (command === '/start' || command === '/help') return [this.response(ctx,
      'Выберите режим. Сначала мысленно выберите бит, затем нажмите «Угадай».\n/resume — продолжить; /stats — счёт; /export — данные; /delete — удалить.', menu)];
    if (command === '/stats') {
      const state = this.service.getProgress(id);
      return [this.response(ctx, `Ходов: ${state.total}. Угадано: ${state.correct}.` )];
    }
    if (command === '/resume') {
      this.db.run('UPDATE telegram_users SET delete_token=NULL WHERE telegram_id=?', ctx.userId);
      const state = this.service.getProgress(id);
      if (state.pendingTurn) return [this.turn(ctx, state.pendingTurn)];
      const session = this.activeSession(id);
      return [this.response(ctx, 'Мысленно выберите 0 или 1, затем нажмите «Угадай».',
        session ? [[button('Угадай', 'g:p:' + session.id)]] : menu)];
    }
    if (/^g:s:[vb]$/.test(data || '')) {
      const session = this.service.startSession(id, { requestId: ctx.key + ':session',
        visibility: data.endsWith('b') ? 'blind' : 'visible', protocolVersion: 'telegram-private-1' });
      return [this.response(ctx, 'Мысленно выберите 0 или 1, затем нажмите «Угадай».', [[button('Угадай', 'g:p:' + session.id)]])];
    }
    const guess = /^g:p:([a-f0-9-]{36})$/.exec(data || '');
    if (guess) {
      const turn = this.service.predict(id, { sessionId: guess[1], requestId: ctx.key + ':predict' });
      this.db.run("INSERT OR IGNORE INTO turn_channels VALUES (?, 'telegram')", turn.id);
      return [this.turn(ctx, turn)];
    }
    const answer = /^g:a:([a-f0-9-]{36}):([01])$/.exec(data || '');
    if (answer) return [this.turn(ctx, this.service.answer(id, { turnId: answer[1], bit: Number(answer[2]), requestId: ctx.key + ':answer' }), 'feedback')];
    return [this.response(ctx, 'Продолжить: /resume. Помощь: /help.')];
  }
  async process(update) {
    this.assertLease();
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Error('INVALID_UPDATE');
    const fingerprint = hash(canonical(update));
    let row = this.db.get('SELECT * FROM telegram_updates WHERE update_id=?', update.update_id);
    if (row?.payload_hash && row.payload_hash !== fingerprint) throw new Error('UPDATE_CONFLICT');
    if (!row) this.db.transaction(() => {
      const ctx = this.context(update);
      let actions = [];
      if (ctx) {
        try { actions = this.plan(ctx); }
        catch (error) {
          const text = domainErrors.get(error.message);
          if (!text) throw error;
          actions = [this.response(ctx, text)];
        }
        if (ctx.query) actions.unshift({ method: 'answerCallbackQuery', payload: { callback_query_id: ctx.query.id } });
      }
      this.db.run('INSERT INTO telegram_updates(update_id,user_id,payload_hash,actions_json,erase_identity) VALUES (?,?,?,?,?)',
        update.update_id, ctx?.eraseIdentity ? null : ctx?.userId ?? null, fingerprint, JSON.stringify(actions), ctx?.eraseIdentity ? 1 : 0);
    });
    await this.deliver(update.update_id);
  }
  async deliver(updateId) {
    this.assertLease();
    const row = this.db.get('SELECT * FROM telegram_updates WHERE update_id=?', updateId);
    if (row.done) return;
    const actions = JSON.parse(row.actions_json);
    const revoked = !row.erase_identity && ((row.user_id && !this.isAllowed(row.user_id)) ||
      actions.some(action => action.payload.chat_id && !this.isAllowed(String(action.payload.chat_id))));
    if (revoked) {
      this.db.run("UPDATE telegram_updates SET done=1,actions_json='[]' WHERE update_id=?", updateId);
      return;
    }
    for (let index = row.next_action; index < actions.length; index++) {
      this.assertLease();
      const action = actions[index];
      let result, rejected;
      try { result = await this.client.call(action.method, action.payload); }
      catch (error) {
        if (![400, 403].includes(error.code)) throw error;
        rejected = error.code;
      }
      this.db.transaction(() => {
        this.assertLease();
        if (action.turnId) this.db.run('INSERT INTO telegram_deliveries VALUES (?,?,?,?,?,?,?,?)',
          updateId, index, action.turnId, action.kind, Date.now(), rejected ? 'rejected' : 'accepted', result?.message_id ?? null, rejected ?? null);
        this.db.run('UPDATE telegram_updates SET next_action=? WHERE update_id=?', index + 1, updateId);
      });
    }
    this.db.transaction(() => {
      this.db.run("UPDATE telegram_updates SET done=1,actions_json='[]',payload_hash=CASE WHEN erase_identity=1 THEN NULL ELSE payload_hash END WHERE update_id=?", updateId);
    });
  }
  async drain() {
    for (const row of this.db.all('SELECT update_id FROM telegram_updates WHERE done=0 ORDER BY update_id')) {
      await this.deliver(row.update_id);
      this.confirmOffset(row.update_id);
    }
  }
  getOffset() {
    const row = this.db.get("SELECT value FROM telegram_meta WHERE key='offset'");
    return row ? Number(row.value) : 0;
  }
  confirmOffset(updateId) {
    this.assertLease();
    const row = this.db.get('SELECT done FROM telegram_updates WHERE update_id=?', updateId);
    if (!row?.done) throw new Error('UPDATE_NOT_DELIVERED');
    this.db.run("INSERT INTO telegram_meta VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(Math.max(this.getOffset(), updateId + 1)));
  }
}
