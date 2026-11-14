'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('server backup includes committed WAL, verifies restoration and limits only its own files', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { backupDatabase } = await import('../scripts/backup-database.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guessgame-server-backup-'));
  const source = path.join(directory, 'live.sqlite');
  const backups = path.join(directory, 'backups');
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES(42)');
    const first = backupDatabase({ databasePath: source, directory: backups, keep: 1 });
    fs.writeFileSync(path.join(backups, 'manual-copy.txt'), 'keep');
    db.exec('INSERT INTO sample VALUES(43)');
    const second = backupDatabase({ databasePath: source, directory: backups, keep: 1 });
    const restored = new DatabaseSync(second.file, { readOnly: true });
    try { assert.equal(restored.prepare('SELECT count(*) AS n FROM sample').get().n, 2); }
    finally { restored.close(); }
    assert.equal(fs.existsSync(first.file), false);
    assert.equal(fs.existsSync(second.file + '.sha256'), true);
    assert.equal(fs.readFileSync(path.join(backups, 'manual-copy.txt'), 'utf8'), 'keep');
    assert.throws(() => backupDatabase({ databasePath: path.join(directory, 'missing.sqlite'), directory: backups }), /unable to open/i);
    assert.equal(fs.existsSync(second.file), true);
    const link = path.join(directory, 'scripts-link');
    fs.symlinkSync(path.resolve(__dirname, '../scripts'), link, 'junction');
    const { execFileSync } = require('node:child_process');
    const output = execFileSync(process.execPath, [path.join(link, 'backup-database.mjs')], {
      encoding: 'utf8', env: { ...process.env, TELEGRAM_DB_PATH: source, BACKUP_DIRECTORY: backups },
    });
    assert.equal(fs.existsSync(JSON.parse(output).file), true);
  } finally { db.close(); }
});
