'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
test('standalone build is deterministic, self-contained and checksummed', () => {
  const root = path.resolve(__dirname, '..');
  const build = () => execFileSync(process.execPath, ['scripts/build.cjs'], { cwd: root });
  build();
  const file = path.join(root, 'dist/GuessGame_next.html');
  const first = fs.readFileSync(file);
  build();
  assert.deepEqual(fs.readFileSync(file), first);
  const html = first.toString('utf8');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /^import .*from /m);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/checksums.json')));
  assert.equal(manifest.files['GuessGame_next.html'],
    crypto.createHash('sha256').update(first).digest('hex'));
});
