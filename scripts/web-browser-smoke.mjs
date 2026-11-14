import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GameService } from '../src/service/game-service.mjs';
import { WebAccounts } from '../src/web/accounts.mjs';
import { createWebServer } from '../src/web/server.mjs';
const executable = process.env.BROWSER_EXECUTABLE;
if (!executable) throw new Error('BROWSER_EXECUTABLE_REQUIRED');
const service = new GameService(':memory:');
const accounts = new WebAccounts(service, { registrationCode: 'synthetic-browser-test', consentText: 'Synthetic browser test only', source: 'simulated' });
let app;
const smoke = `
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let phase='load';
async function wait(check){for(let i=0;i<200;i++){if(check())return;await sleep(25);}throw Error('UI_TIMEOUT '+phase+': '+$('notice').textContent);}
try {
await wait(()=>$('consent-text').textContent); await sleep(150);
$('tab-register').click();$('login').value='browser_user';$('password').value='synthetic-browser-password';$('registration-code').value='synthetic-browser-test';$('consent').checked=true;
phase='register';
$('auth-form').requestSubmit();await wait(()=>!$('workspace').hidden);
phase='predict';
$('predict').click();await wait(()=>!$('answer-buttons').hidden);document.querySelector('[data-bit="1"]').click();await wait(()=>$('total').textContent==='1');
phase='relogin';
$('logout').click();await wait(()=>!$('auth').hidden);$('tab-login').click();$('login').value='browser_user';$('password').value='synthetic-browser-password';$('auth-form').requestSubmit();await wait(()=>!$('workspace').hidden&&$('total').textContent==='1');
phase='link';document.querySelector('[data-tab="account"]').click();$('telegram-id').value='101';$('link-form').requestSubmit();await wait(()=>!$('link-command-box').hidden);
if(!$('link-command').textContent.startsWith('/link '))throw Error('LINK_COMMAND_MISSING');
phase='laboratory';document.querySelector('[data-tab="lab"]').click();await sleep(100);$('lab-form').requestSubmit();await wait(()=>!$('lab-export').hidden);
if(!$('lab-result').textContent.includes('413'))throw Error('REFERENCE_SIMULATION_CHANGED');
document.body.setAttribute('data-web-smoke','PASS');
}catch(error){document.body.setAttribute('data-web-smoke','FAIL: '+error.message);}
`;
const proxy = createServer((req, res) => {
  if (req.url === '/qa.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(smoke); return; }
  const upstream = request({ hostname: '127.0.0.1', port: app.address().port, path: req.url, method: req.method, headers: req.headers }, result => {
    res.writeHead(result.statusCode, result.headers);
    if (req.url === '/') {
      let html = ''; result.setEncoding('utf8'); result.on('data', c => html += c);
      result.on('end', () => res.end(html.replace('</body>', '<script type="module" src="/qa.js"></script></body>')));
    } else result.pipe(res);
  });
  req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + proxy.address().port;
app = createWebServer({ service, accounts, origin, secureCookies: false });
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
try {
  const profile = mkdtempSync(join(tmpdir(), 'guessgame-web-browser-'));
  const child = spawn(executable, ['--headless', '--no-first-run', '--disable-background-networking', '--disable-extensions',
    '--user-data-dir=' + profile, '--virtual-time-budget=20000', '--dump-dom', origin], { windowsHide: true });
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); clearTimeout(timer);
  const outcome = output.match(/<body[^>]*data-web-smoke="([^"]+)"/);
  if (code !== 0 || outcome?.[1] !== 'PASS') { writeFileSync('private/deploy/web-smoke-output.html', output); throw new Error(outcome?.[1] || 'BROWSER_SMOKE_INCOMPLETE'); }
  console.log('PASS web browser: registration, login, move, logout, link code, 413/600 laboratory');
} finally {
  proxy.closeAllConnections(); app.closeAllConnections();
  await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>app.close(r))]); service.close();
}
