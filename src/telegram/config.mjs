import { resolve } from 'node:path';
export function loadTelegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUserIds = (env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const consentText = env.TELEGRAM_CONSENT_TEXT?.trim();
  const consentVersion = env.TELEGRAM_CONSENT_VERSION?.trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '')) throw new Error('Set TELEGRAM_BOT_TOKEN in local .env');
  if (!allowedUserIds.length || !allowedUserIds.every(id => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))) {
    throw new Error('Set TELEGRAM_ALLOWED_USER_IDS to your numeric Telegram ID');
  }
  if (!consentText || consentText.length > 3000 || !consentVersion || consentVersion.length > 100) {
    throw new Error('Set TELEGRAM_CONSENT_TEXT and TELEGRAM_CONSENT_VERSION in local .env');
  }
  return { token, allowedUserIds, consentText, consentVersion,
    databasePath: resolve(env.TELEGRAM_DB_PATH || 'private/telegram.sqlite') };
}
