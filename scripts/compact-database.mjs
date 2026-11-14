import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GameService } from '../src/service/game-service.mjs';
import { backupDatabase } from './backup-database.mjs';

function factsDigest(repository) {
  const hash = createHash('sha256');
  const tables = repository.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'predictor_snapshots' ORDER BY name");
  for (const { name } of tables) {
    const rows = repository.all('SELECT * FROM "' + name.replaceAll('"', '""') + '"').map(row => JSON.stringify(row)).sort();
    hash.update(JSON.stringify([name, rows]));
  }
  return hash.digest('hex');
}

export function compactDatabase({ databasePath, directory, apply = false }) {
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const lease = source.prepare("SELECT value FROM telegram_meta WHERE key='polling_lease'").get();
    if (lease && JSON.parse(lease.value).expires > Date.now()) throw new Error('STOP_BOT_AND_WEB_FIRST');
  } finally { source.close(); }
  const backup = backupDatabase({ databasePath, directory });
  const target = apply ? databasePath : backup.file.replace(/\.sqlite$/, '.preview.sqlite');
  if (!apply) copyFileSync(backup.file, target);
  const game = new GameService(target);
  let report;
  try {
    game.repository.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const databaseBytesBefore = statSync(target).size;
    const before = factsDigest(game.repository);
    const models = game.repository.all('SELECT id FROM participants').map(({ id }) => ({ id,
      checksum: createHash('sha256').update(JSON.stringify(game.getState(id))).digest('hex') }));
    const metrics = game.compactSnapshots();
    if (factsDigest(game.repository) !== before) throw new Error('FACTS_CHANGED');
    game.repository.db.exec('VACUUM');
    game.repository.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (factsDigest(game.repository) !== before) throw new Error('FACTS_CHANGED');
    for (const { id, checksum } of models) {
      for (const state of [game.getState(id), game.replayEngine(id).exportState()]) {
        if (createHash('sha256').update(JSON.stringify(state)).digest('hex') !== checksum) throw new Error('MODEL_CHANGED');
      }
    }
    if (game.repository.get('PRAGMA integrity_check').integrity_check !== 'ok' || game.repository.all('PRAGMA foreign_key_check').length) throw new Error('DATABASE_INTEGRITY_FAILED');
    report = { applied: apply, ...metrics, databaseBytesBefore, databaseBytesAfter: statSync(target).size,
      factsPreserved: true, modelsPreserved: true, backupFile: backup.file, backupChecksum: backup.checksum };
  } finally { game.close(); }
  writeFileSync(backup.file.replace(/\.sqlite$/, '.maintenance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    console.log(JSON.stringify(compactDatabase({ databasePath: resolve(process.env.TELEGRAM_DB_PATH || 'private/telegram.sqlite'),
      directory: resolve(process.env.BACKUP_DIRECTORY || 'private/backups/maintenance'), apply: process.argv.includes('--apply') })));
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'COMPACTION_FAILED'); process.exitCode = 1;
  }
}
