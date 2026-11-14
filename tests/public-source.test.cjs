'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
test('publication guard blocks a gameplay export and credentials without echoing contents', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-public-check-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const script = path.resolve(__dirname, '../scripts/check-public-source.mjs');
  const run = () => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  fs.writeFileSync(path.join(cwd, 'state.json'), JSON.stringify({ history: [0,1], moveTimes: [1,2] }));
  execFileSync('git', ['add', 'state.json'], { cwd });
  const blocked = run();
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /state.json/);
  execFileSync('git', ['rm', '--cached', 'state.json'], { cwd });
  const secret = '123456789:' + 'A'.repeat(35);
  fs.writeFileSync(path.join(cwd, 'config.txt'), secret);
  execFileSync('git', ['add', 'config.txt'], { cwd });
  const credential = run(); assert.equal(credential.status, 1); assert.equal(credential.stderr.includes(secret), false);
  execFileSync('git', ['rm', '--cached', 'config.txt'], { cwd });
  // An unborn repository has no reachable history yet.
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Synthetic test repository');
  execFileSync('git', ['add', 'README.md'], { cwd });
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(cwd, 'large.txt'), secret + '\n' + 'x'.repeat(2 * 1024 * 1024));
  execFileSync('git', ['add', 'large.txt'], { cwd });
  const large = run(); assert.equal(large.status, 1);
  assert.equal((large.stderr + large.stdout).includes(secret), false);
});
