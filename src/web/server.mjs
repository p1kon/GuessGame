import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { eraseParticipant, exportParticipant } from '../service/account-data.mjs';

const fail = code => { throw new Error(code); };
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/app.css', ['app.css', 'text/css']], ['/lab.js', ['lab.js', 'text/javascript']],
]);
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
function csrfMatches(actual, expected) {
  return typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('INVALID_JSON');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 16384) fail('BODY_TOO_LARGE'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON'); return value; }
  catch { fail('INVALID_JSON'); }
}
export function createWebServer({ service, accounts, origin, secureCookies = true, botUsername = '', trustProxy = false }) {
  const db = service.repository;
  const cookieName = secureCookies ? '__Host-gg_session' : 'gg_session';
  const sessionCookie = (token, clear = false) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 604800}${secureCookies ? '; Secure' : ''}`;
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (secureCookies && req.headers.host !== new URL(origin).host) { json(404, { error: 'NOT_FOUND' }); return; }
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [file, type] = files.get(path);
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        res.end(readFileSync(new URL('./public/' + file, import.meta.url))); return;
      }
      if (req.method === 'GET' && /^\/core\/(index|predictor|simulation|virtual-player)\.mjs$/.test(path)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(readFileSync(new URL('..' + path, import.meta.url))); return;
      }
      if (path === '/healthz' && req.method === 'GET') { json(200, { ok: true }); return; }
      if (path === '/api/config' && req.method === 'GET') {
        json(200, { consentText: accounts.consentText, registrationRequiresCode: true, botUsername }); return;
      }
      if (!path.startsWith('/api/')) { json(404, { error: 'NOT_FOUND' }); return; }
      const ip = trustProxy && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : req.socket.remoteAddress;
      accounts.rate('api:' + ip, 240, 60000);
      const post = req.method === 'POST';
      if (!post && req.method !== 'GET') fail('METHOD_NOT_ALLOWED');
      if (post && req.headers.origin !== origin) fail('ORIGIN_REQUIRED');
      const body = post ? await readJson(req) : null;
      if (post && ['/api/auth/register', '/api/auth/login'].includes(path)) {
        const session = path.endsWith('register') ? await accounts.register(body, ip) : await accounts.login(body, ip);
        res.setHeader('Set-Cookie', sessionCookie(session.token));
        json(path.endsWith('register') ? 201 : 200, { ok: true }); return;
      }
      const token = cookieValue(req, cookieName);
      const account = accounts.authenticate(token);
      if (post && !csrfMatches(req.headers['x-csrf-token'], account.csrf)) fail('CSRF_REQUIRED');
      const id = account.participantId;
      const requestId = () => {
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.requestId)) fail('INVALID_REQUEST_ID');
        return 'web:' + account.id + ':' + body.requestId;
      };
      if (path === '/api/auth/me' && !post) { json(200, { username: account.username, telegramId: account.telegramId, csrf: account.csrf }); return; }
      if (path === '/api/auth/logout' && post) {
        accounts.logout(token); res.setHeader('Set-Cookie', sessionCookie('', true)); json(200, { ok: true }); return;
      }
      if (path === '/api/account/password' && post) {
        accounts.rate('password:' + account.id, 5);
        await accounts.changePassword(account.id, body.currentPassword, body.password);
        res.setHeader('Set-Cookie', sessionCookie('', true)); json(200, { ok: true }); return;
      }
      if (path === '/api/account/telegram-link' && post) { json(200, accounts.createLink(account.id, body.telegramId)); return; }
      if (path === '/api/account/delete' && post) {
        accounts.rate('delete:' + account.id, 5);
        await accounts.verifyCurrentPassword(account.id, body.password);
        eraseParticipant(service, accounts.authenticate(token).participantId); res.setHeader('Set-Cookie', sessionCookie('', true)); json(200, { ok: true }); return;
      }
      if (path === '/api/account/export' && !post) {
        const exported = service.repository.transaction(() => exportParticipant(service, id));
        res.setHeader('Content-Disposition', 'attachment; filename="GuessGame_export.json"'); json(200, exported); return;
      }
      if (path === '/api/game/state' && !post) {
        const value = db.transaction(() => {
          const progress = service.getProgress(id);
          const active = db.get('SELECT id,visibility FROM sessions WHERE participant_id=? AND ended_at IS NULL', id);
          const state = service.engine(id).exportState();
          const recent = state.history.slice(-20).map((bit, i) => {
            const at = state.history.length - Math.min(20, state.history.length) + i;
            return { seq: at + 1, bit, prediction: state.predictions[at], source: state.forecastLog[at]?.source ?? 'legacy' };
          });
          return { ...progress, session: active ?? null, recent,
            experts: Object.entries(state.weights).map(([name, weight]) => ({ name, weight })) };
        });
        json(200, value); return;
      }
      if (path === '/api/game/session' && post) {
        json(200, service.startSession(id, { requestId: requestId(), visibility: body.visibility, protocolVersion: 'web-private-1' })); return;
      }
      if (path === '/api/game/predict' && post) {
        const key = requestId();
        const turn = service.command(id, key, ['web-predict'], () => {
          const active = db.get('SELECT id FROM sessions WHERE participant_id=? AND ended_at IS NULL', id) ||
            service.startSession(id, { requestId: key + ':session', protocolVersion: 'web-private-1' });
          const result = service.predict(id, { sessionId: active.id, requestId: key + ':predict' });
          db.run("INSERT OR IGNORE INTO turn_channels VALUES (?, 'web')", result.id);
          return result;
        });
        json(200, turn); return;
      }
      if (path === '/api/game/answer' && post) {
        json(200, service.answer(id, { requestId: requestId(), turnId: body.turnId, bit: body.bit })); return;
      }
      json(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const statuses = { UNAUTHORIZED: 401, INVALID_CREDENTIALS: 401, CSRF_REQUIRED: 403, ORIGIN_REQUIRED: 403,
        REGISTRATION_CLOSED: 403, RATE_LIMITED: 429, BODY_TOO_LARGE: 413, METHOD_NOT_ALLOWED: 405,
        INVALID_JSON: 400, INVALID_REGISTRATION: 400, INVALID_PASSWORD: 400, INVALID_REQUEST_ID: 400,
        INVALID_TELEGRAM_ID: 400, INVALID_BIT: 400, INVALID_VISIBILITY: 400, USERNAME_TAKEN: 409,
        PENDING_TURN: 409, TURN_FINALIZED: 409, PENDING_BLIND_EXPORT: 409, SESSION_CLOSED: 409,
        IDEMPOTENCY_CONFLICT: 409, NOT_FOUND: 404 };
      json(statuses[error.message] || 500, { error: statuses[error.message] ? error.message : 'SERVER_ERROR' });
    }
  });
}
