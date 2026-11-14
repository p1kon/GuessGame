const $ = id => document.getElementById(id);
let me = null, config, registering = false, current = null;
const intents = new Map();
const messages = {
  INVALID_CREDENTIALS: 'Неверный логин или пароль.', USERNAME_TAKEN: 'Этот логин уже занят.',
  INVALID_REGISTRATION: 'Проверьте логин, пароль (от 12 символов) и согласие на участие.',
  REGISTRATION_CLOSED: 'Неверный код доступа. Получите его у владельца игры.',
  RATE_LIMITED: 'Слишком много запросов. Подождите и повторите попытку.',
  PENDING_TURN: 'Сначала ответьте на текущий прогноз. Он мог быть начат в Telegram.',
  TURN_FINALIZED: 'Этот ход уже завершён. Показан актуальный счёт.',
  INVALID_TELEGRAM_ID: 'Укажите числовой Telegram ID, а не username.',
  INVALID_PASSWORD: 'Новый пароль должен содержать от 12 до 128 символов.',
  SERVER_ERROR: 'Не удалось выполнить действие. Попробуйте ещё раз.',
  CSRF_REQUIRED: 'Сессия изменилась. Обновите страницу и повторите действие.',
};
function notice(text = '') { $('notice').textContent = text; }
async function api(path, body) {
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf } : {}) },
      credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error('Связь прервалась. Сохранённый ход можно восстановить кнопкой «Обновить».'); }
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') showAuth();
    throw new Error(messages[value.error] || 'Не удалось выполнить действие. Обновите страницу.');
  }
  return value;
}
function showAuth() {
  me = null; current = null;
  $('auth').hidden = false; $('workspace').hidden = true; $('identity').hidden = true;
}
function tab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('selected', button.dataset.tab === name);
  for (const id of ['game', 'account', 'lab']) $('panel-' + id).hidden = name !== id;
  if (name === 'lab') import('/lab.js').catch(error => notice(error.message));
}
function authMode(register) {
  registering = register;
  $('tab-login').classList.toggle('selected', !register); $('tab-register').classList.toggle('selected', register);
  $('register-fields').hidden = !register;
  $('registration-code').required = register; $('consent').required = register;
  $('password').minLength = register ? 12 : 1;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-title').textContent = register ? 'Начнём знакомство' : 'С возвращением';
  $('auth-subtitle').textContent = register ? 'Ваша модель и история будут принадлежать только вам.' : 'Продолжите игру со своей моделью.';
  $('auth-submit').textContent = register ? 'Создать аккаунт' : 'Войти'; notice();
}
function renderMe() {
  $('username').textContent = me.username;
  $('telegram-status').textContent = me.telegramId ? 'Привязан Telegram ID: ' + me.telegramId : 'Telegram пока не привязан.';
  $('link-form').hidden = Boolean(me.telegramId);
  if (me.telegramId) $('link-command-box').hidden = true;
}
function render(state) {
  current = state;
  $('total').textContent = state.total.toLocaleString('ru');
  $('correct').textContent = state.correct.toLocaleString('ru');
  const accuracy = state.total ? 100 * state.correct / state.total : 0;
  $('accuracy').textContent = state.total ? accuracy.toFixed(1) + '%' : '—';
  $('accuracy-meter').style.width = accuracy + '%';
  $('link-hint').hidden = Boolean(me?.telegramId) || state.total > 0;
  const pending = state.pendingTurn;
  const blind = pending ? pending.visibility === 'blind' : state.session?.visibility === 'blind';
  $('blind').checked = blind; $('blind').disabled = Boolean(pending);
  $('mode-label').textContent = blind ? 'Слепой режим' : 'Видимый режим';
  $('predict').hidden = Boolean(pending); $('answer-buttons').hidden = !pending;
  $('prediction').textContent = pending && !blind ? pending.prediction : '?';
  $('play-title').textContent = pending ? 'Какой бит вы выбрали?' : 'Мысленно выберите 0 или 1';
  $('play-help').textContent = pending ? (blind ? 'Прогноз уже сохранён и будет раскрыт после ответа.' : `Прогноз сохранён. P(1) = ${pending.p1.toFixed(3)}.`) : 'Определитесь с выбором, затем попросите модель угадать.';
  if (pending) intents.delete('predict');
  else for (const key of intents.keys()) if (key.startsWith('answer:')) intents.delete(key);
  $('recent').replaceChildren();
  for (const row of state.recent) {
    const span = document.createElement('span'); span.textContent = row.bit;
    if (row.prediction === row.bit) span.className = 'hit';
    span.title = `Ход ${row.seq}. Ваш бит: ${row.bit}. Прогноз: ${row.prediction ?? 'не сохранён'}.`;
    $('recent').append(span);
  }
  $('experts').replaceChildren();
  for (const expert of state.experts) {
    const row = document.createElement('div'); row.className = 'expert';
    const name = document.createElement('span'), weight = document.createElement('strong');
    name.textContent = expert.name; weight.textContent = expert.weight.toFixed(3); row.append(name, weight); $('experts').append(row);
  }
}
async function refresh() {
  if (!me) return;
  const updated = await api('/api/auth/me');
  me = updated; renderMe(); render(await api('/api/game/state'));
}
async function signedIn() {
  me = await api('/api/auth/me');
  $('auth').hidden = true; $('workspace').hidden = false; $('identity').hidden = false;
  $('password').value = ''; tab('game'); await refresh();
}
function action(element, handler) {
  element.addEventListener('click', async () => {
    element.disabled = true; notice();
    try { await handler(); } catch (error) { notice(error.message); }
    finally { element.disabled = false; }
  });
}
async function move(key, path, payload = {}) {
  if (!intents.has(key)) intents.set(key, crypto.randomUUID());
  try {
    const result = await api(path, { ...payload, requestId: intents.get(key) });
    intents.delete(key); await refresh(); return result;
  } catch (error) { await refresh().catch(() => {}); throw error; }
}
$('tab-login').onclick = () => authMode(false);
$('tab-register').onclick = () => authMode(true);
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-submit').disabled = true; notice();
  try {
    await api(registering ? '/api/auth/register' : '/api/auth/login', {
      username: $('login').value.trim(), password: $('password').value,
      ...(registering ? { registrationCode: $('registration-code').value.trim(), consent: $('consent').checked } : {}),
    });
    await signedIn();
  } catch (error) { notice(error.message); } finally { $('auth-submit').disabled = false; }
});
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => { tab(button.dataset.tab); notice(); };
action($('open-link'), () => tab('account'));
action($('logout'), async () => { await api('/api/auth/logout', {}); showAuth(); });
action($('refresh'), refresh);
action($('predict'), async () => { $('feedback').textContent = ''; await move('predict', '/api/game/predict'); });
for (const button of document.querySelectorAll('[data-bit]')) action(button, async () => {
  const turn = current?.pendingTurn; if (!turn) return;
  const all = document.querySelectorAll('[data-bit]'); all.forEach(b => b.disabled = true);
  try {
    const result = await move('answer:' + turn.id + ':' + button.dataset.bit, '/api/game/answer', { turnId: turn.id, bit: Number(button.dataset.bit) });
    $('feedback').textContent = `Модель: ${result.prediction}, ваш бит: ${result.actualBit}. ${result.hit ? 'Угадано.' : 'Не угадано.'}`;
  } finally { all.forEach(b => b.disabled = false); }
});
$('blind').addEventListener('change', async () => {
  try { await move('mode-' + $('blind').checked, '/api/game/session', { visibility: $('blind').checked ? 'blind' : 'visible' }); }
  catch (error) { notice(error.message); }
});
$('link-form').addEventListener('submit', async event => {
  event.preventDefault(); notice();
  const button = event.submitter || $('link-form').querySelector('button[type="submit"]'); button.disabled = true;
  try {
    const link = await api('/api/account/telegram-link', { telegramId: $('telegram-id').value.trim() });
    $('link-command').textContent = '/link ' + link.code; $('link-command-box').hidden = false;
    if (config.botUsername) $('bot-link').href = 'https://t.me/' + config.botUsername;
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
action($('copy-link'), async () => { await navigator.clipboard.writeText($('link-command').textContent); notice('Команда скопирована. Отправьте её боту и подтвердите свой веб-логин.'); });
$('password-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter || $('password-form').querySelector('button[type="submit"]'); button.disabled = true; notice();
  try {
    await api('/api/account/password', { currentPassword: $('current-password').value, password: $('new-password').value });
    $('password-form').reset(); showAuth(); notice('Пароль изменён. Войдите заново.');
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!confirm('Удалить общий аккаунт и историю в вебе и боте?')) return;
  const button = event.submitter || $('delete-form').querySelector('button[type="submit"]'); button.disabled = true;
  try { await api('/api/account/delete', { password: $('delete-password').value }); $('delete-form').reset(); showAuth(); notice('Аккаунт и история удалены из рабочей базы.'); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
});
try {
  config = await api('/api/config'); $('consent-text').textContent = config.consentText;
  await signedIn();
} catch { showAuth(); }
setInterval(() => { if (me && !document.hidden) refresh().catch(() => {}); }, 5000);
