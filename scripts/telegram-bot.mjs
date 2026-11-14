import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GameService } from '../src/service/game-service.mjs';
import { TelegramClient } from '../src/telegram/client.mjs';
import { TelegramAdapter } from '../src/telegram/adapter.mjs';
import { loadTelegramConfig } from '../src/telegram/config.mjs';
import { pollOnce } from '../src/telegram/polling.mjs';
import { PollingLease } from '../src/telegram/lease.mjs';
import { WebAccounts } from '../src/web/accounts.mjs';

let service;
let lease, heartbeat;
const stop = new AbortController();
process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());
try {
  const config = loadTelegramConfig();
  if (process.argv.includes('--check')) {
    console.log('Конфигурация заполнена. Сеть и база данных не использовались.');
  } else {
    const client = new TelegramClient(config.token, { signal: stop.signal });
    const bot = await client.call('getMe', {}, { signal: stop.signal });
    if (!bot.is_bot || !Number.isSafeInteger(bot.id)) throw new Error('INVALID_BOT_IDENTITY');
    const webhook = await client.call('getWebhookInfo', {}, { signal: stop.signal });
    if (webhook.url) throw new Error('WEBHOOK_ACTIVE: existing webhook must be reviewed before polling');
    mkdirSync(dirname(config.databasePath), { recursive: true });
    service = new GameService(config.databasePath);
    lease = new PollingLease(service.repository);
    const webAccounts = process.env.WEB_REGISTRATION_CODE ? new WebAccounts(service, {
      registrationCode: process.env.WEB_REGISTRATION_CODE,
      consentText: process.env.WEB_CONSENT_TEXT || config.consentText,
    }) : null;
    const adapter = new TelegramAdapter({ service, client, botId: bot.id, ...config, webAccounts, assertLease: () => lease.assert() });
    heartbeat = setInterval(() => {
      try { lease.renew(); }
      catch { console.error('Потеряна блокировка процесса. Бот остановлен.'); process.exitCode = 1; stop.abort(); }
    }, 10000);
    console.log('Закрытый Telegram-бот запущен. Для остановки нажмите Ctrl+C.');
    while (!stop.signal.aborted) {
      try { await pollOnce({ client, adapter, signal: stop.signal }); }
      catch (error) {
        if (stop.signal.aborted) break;
        if ([401, 409].includes(error.code)) throw error;
        const retryable = error.message === 'TELEGRAM_NETWORK_ERROR' || error.code === 429 || error.code >= 500;
        if (!retryable) throw new Error('BOT_STOPPED: local processing failed; updates remain unconfirmed');
        console.error('Telegram временно недоступен. Повторяю запрос.');
        const deadline = Date.now() + Math.max(2000, (error.retryAfter || 0) * 1000);
        while (!stop.signal.aborted && Date.now() < deadline) {
          await delay(Math.min(30000, deadline - Date.now()), undefined, { signal: stop.signal });
        }
      }
    }
  }
} catch (error) {
  if (!stop.signal.aborted) {
    // Only controlled messages from our modules; never raw API bodies or tokens.
    const safe = /^(Set |TELEGRAM_API_|WEBHOOK_ACTIVE|INVALID_BOT_IDENTITY|BOT_STOPPED|DATABASE_BELONGS_TO_ANOTHER_BOT|POLLER_ALREADY_RUNNING)/.test(error.message);
    console.error(safe ? error.message : 'Запуск не завершён. Проверьте локальную конфигурацию и доступ к базе.');
    process.exitCode = 1;
  }
} finally {
  clearInterval(heartbeat);
  try { lease?.release(); } finally { service?.close(); }
}
