import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, readdirSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function backupDatabase({ databasePath, directory, keep = 14 }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('INVALID_BACKUP_RETENTION');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = 'guessgame-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + randomUUID() + '.sqlite';
  const file = join(root, name);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout=5000');
    source.prepare('VACUUM INTO ?').run(file);
  } finally { source.close(); }
  chmodSync(file, 0o600);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        copy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('BACKUP_INVALID');
  } finally { copy.close(); }
  const checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(file + '.sha256', checksum + '  ' + name + '\n', { mode: 0o600 });
  const owned = readdirSync(root).filter(value => /^guessgame-\d{17}-[a-f0-9-]{36}\.sqlite$/.test(value)).sort().reverse();
  for (const old of owned.slice(keep)) {
    unlinkSync(join(root, old));
    try { unlinkSync(join(root, old + '.sha256')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { file, checksum };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    console.log(JSON.stringify(backupDatabase({ databasePath: process.env.TELEGRAM_DB_PATH || 'private/telegram.sqlite',
      directory: process.env.BACKUP_DIRECTORY || 'private/backups/automatic' })));
  } catch { console.error('BACKUP_FAILED'); process.exitCode = 1; }
}
