import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// VACUUM INTO creates a consistent SQLite snapshot, including committed WAL
// content. The source is opened read-only, before any application migration.
export function backupHistoryDatabase(databasePath) {
  const directory = join(dirname(databasePath), 'backups');
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const backupPath = join(directory, 'before-history-import-' + timestamp + '-' + randomUUID().slice(0, 8) + '.sqlite');
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const lease = source.prepare("SELECT value FROM telegram_meta WHERE key='polling_lease'").get();
    if (lease && JSON.parse(lease.value).expires > Date.now()) throw new Error('BOT_IS_RUNNING');
    source.prepare('VACUUM INTO ?').run(backupPath);
  } finally { source.close(); }
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED');
  } finally { backup.close(); }
  return { backupPath, backupChecksum: createHash('sha256').update(readFileSync(backupPath)).digest('hex') };
}
