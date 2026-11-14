'use strict';
// Optional real-browser check. BROWSER_EXECUTABLE must point to Chromium/Edge.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const executable = process.env.BROWSER_EXECUTABLE;
if (!executable) throw new Error('Set BROWSER_EXECUTABLE to Chromium/Edge');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-browser-'));
const smoke = `
<script>
try {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  localStorage.clear();
  document.getElementById('btnGuess').click();
  document.getElementById('btnOne').click();
  check(state.total === 1, 'manual turn');
  check(JSON.parse(localStorage.getItem(STORAGE_KEY)).total === 1, 'persisted turn');
  const savedSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function() { throw new Error('forced quota failure'); };
  document.getElementById('btnGuess').click();
  document.getElementById('btnZero').click();
  check(state.total === 2 && !!saveError, 'continue in RAM on failure');
  window.confirm = () => true;
  window.alert = () => {};
  document.getElementById('btnReset').click();
  check(state.total === 2, 'failed reset preserves RAM');
  check(JSON.parse(localStorage.getItem(STORAGE_KEY)).total === 1, 'failed reset preserves storage');
  Storage.prototype.setItem = savedSetItem;
  persistOrMarkUnsaved();
  check(!saveError && JSON.parse(localStorage.getItem(STORAGE_KEY)).total === 2, 'retry');
  document.getElementById('btnReset').click();
  check(state.total === 0, 'successful reset');
  const runner = new SimulationRunner({params:{I:.9,S:.7,M:10,C:.25,Q:.5,E:.6,D:.7,G:-1},turns:60,sessionSize:20});
  while(runner.step() !== null) {}
  check(runner.summary().n === 60, 'browser laboratory');
  document.body.setAttribute('data-smoke', 'PASS');
} catch(error) {
  document.body.setAttribute('data-smoke', 'FAIL: ' + error.message);
}
</script>`;
const html = fs.readFileSync(path.join(root, 'dist/GuessGame_next.html'), 'utf8');
const file = path.join(directory, 'smoke.html');
fs.writeFileSync(file, html.replace('</body>', smoke + '\n</body>'));
const result = spawnSync(executable, ['--headless', '--no-first-run',
  '--disable-background-networking', '--disable-extensions',
  '--user-data-dir=' + path.join(directory, 'profile'), '--dump-dom', pathToFileURL(file).href],
{ encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr.slice(-1000));
const outcome = result.stdout.match(/<body[^>]*data-smoke="([^"]+)"/);
assert.equal(outcome?.[1], 'PASS', outcome?.[1] || 'Browser did not finish smoke checks');
console.log('PASS browser: manual turn, quota failure, reset, retry, laboratory');
// The temporary profile contains synthetic data only; it is never published.
