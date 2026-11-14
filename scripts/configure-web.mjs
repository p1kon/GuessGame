import { appendFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TelegramClient } from '../src/telegram/client.mjs';
const file = process.argv[2], accessFile = process.argv[3];
if (!file || !accessFile) throw new Error('CONFIG_PATHS_REQUIRED');
const origin = process.env.PUBLIC_WEB_ORIGIN || 'https://67.21.76.143';
const registrationCode = process.env.WEB_REGISTRATION_CODE || randomBytes(18).toString('base64url');
const consentText = process.env.WEB_CONSENT_TEXT || 'Закрытое техническое тестирование GuessGame. Сохраняются ваши биты, исходные прогнозы, время, режим игры и состояние модели. При привязке Telegram сохраняется отдельная связь с его ID. Данные хранятся на сервере владельца до удаления аккаунта. Экспорт и удаление доступны в личном кабинете. Удаление из рабочей базы не удаляет ранее сделанные резервные копии и сообщения Telegram. Участие добровольное.';
const bot = await new TelegramClient(process.env.TELEGRAM_BOT_TOKEN).call('getMe');
appendFileSync(file, '\n' + Object.entries({ PUBLIC_WEB_ORIGIN: origin, WEB_REGISTRATION_CODE: registrationCode,
  WEB_CONSENT_TEXT: consentText, WEB_BOT_USERNAME: bot.username || '', TELEGRAM_CONSENT_TEXT: consentText,
  TELEGRAM_CONSENT_VERSION: 'shared-account-test-1' }).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n');
writeFileSync(accessFile, `Адрес: ${origin}\nКод доступа для регистрации: ${registrationCode}\nПосле регистрации сначала привяжите Telegram в личном кабинете, до первого веб-хода.\n`, { mode: 0o600 });
console.log('WEB_CONFIGURATION_READY');
