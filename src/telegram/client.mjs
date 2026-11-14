export class TelegramApiError extends Error {
  constructor(code, retryAfter = 0) {
    super('TELEGRAM_API_' + code);
    this.code = code; this.retryAfter = retryAfter;
  }
}

export class TelegramClient {
  constructor(token, { fetchImpl = globalThis.fetch, signal } = {}) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '')) throw new Error('INVALID_BOT_TOKEN');
    this.token = token; this.fetch = fetchImpl;
    this.signal = signal;
  }
  async call(method, payload = {}, { signal } = {}) {
    signal ??= this.signal;
    if (!['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'editMessageText',
      'answerCallbackQuery', 'sendDocument'].includes(method)) throw new Error('UNSUPPORTED_TELEGRAM_METHOD');
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35000 : 30000);
    const options = { method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error' };
    if (method === 'sendDocument') {
      const form = new FormData();
      form.set('chat_id', String(payload.chat_id));
      form.set('document', new Blob([payload.documentText], { type: 'application/json' }), payload.filename);
      options.body = form;
    } else {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    let response, body;
    try {
      response = await this.fetch('https://api.telegram.org/bot' + this.token + '/' + method, options);
      body = await response.json();
    } catch {
      // Fetch errors may include the request URL containing the secret token.
      // Never forward that URL or the original error/cause to logs.
      throw new Error(signal?.aborted ? 'TELEGRAM_STOPPED' : 'TELEGRAM_NETWORK_ERROR');
    }
    if (!response.ok || body.ok !== true) {
      const code = Number.isInteger(body.error_code) ? body.error_code : response.status;
      if (method === 'editMessageText' && code === 400 && /message is not modified/i.test(body.description || '')) return true;
      const retry = body.parameters?.retry_after;
      throw new TelegramApiError(code, Number.isSafeInteger(retry) && retry > 0 ? retry : 0);
    }
    return body.result;
  }
}
