import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { GameService } from '../src/service/game-service.mjs';
import { backupHistoryDatabase } from '../src/service/history-backup.mjs';
import { loadTelegramConfig } from '../src/telegram/config.mjs';

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--'));
const apply = args.includes('--apply');
const userArg = args.find(arg => arg.startsWith('--user='))?.slice(7);
if (!file) {
  console.error('Usage: npm.cmd run telegram:import -- "path/to/state.json" [--apply] [--user=ID]');
  process.exitCode = 1;
} else {
  let preview, live;
  try {
    const config = loadTelegramConfig();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const source = new DatabaseSync(config.databasePath, { readOnly: true });
    let player, expectedChecksum;
    try {
      const candidates = config.allowedUserIds.filter(id => !userArg || id === userArg)
        .map(id => source.prepare('SELECT participant_id FROM telegram_users WHERE telegram_id=?').get(id)).filter(Boolean);
      if (candidates.length !== 1) throw new Error('SELECT_ONE_ALLOWED_PLAYER_WITH_USER_ARGUMENT');
      player = candidates[0].participant_id;
      expectedChecksum = source.prepare('SELECT s.checksum FROM predictor_snapshots s JOIN participants p ON p.id=s.participant_id AND p.revision=s.revision WHERE p.id=?').get(player)?.checksum;
      if (!expectedChecksum) throw new Error('CURRENT_SNAPSHOT_MISSING');
    } finally { source.close(); }
    const backup = backupHistoryDatabase(config.databasePath);
    const previewPath = backup.backupPath.replace(/\.sqlite$/, '.preview.sqlite');
    copyFileSync(backup.backupPath, previewPath);
    preview = new GameService(previewPath);
    const result = preview.importHistory(player, raw, { source: 'human' });
    const afterImport = preview.getState(player);
    const verified = preview.recover(player);
    if (JSON.stringify(verified) !== JSON.stringify(afterImport)) throw new Error('PREVIEW_VERIFICATION_FAILED');
    preview.close(); preview = null;
    if (apply) {
      live = new GameService(config.databasePath);
      live.repository.transaction(() => {
        const current = live.repository.get('SELECT s.checksum FROM predictor_snapshots s JOIN participants p ON p.id=s.participant_id AND p.revision=s.revision WHERE p.id=?', player);
        if (current?.checksum !== expectedChecksum) throw new Error('DATABASE_CHANGED_AFTER_BACKUP');
        const applied = live.importHistory(player, raw, { source: 'human' });
        if (JSON.stringify(applied) !== JSON.stringify(result)) throw new Error('APPLY_PREVIEW_MISMATCH');
      });
      live.close(); live = null;
    }
    const report = { applied: apply, ...result, currentTotal: verified.total, currentCorrect: verified.correct, ...backup, previewPath };
    writeFileSync(backup.backupPath.replace(/\.sqlite$/, '.report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Do not print source histories, Telegram IDs, config values or raw SQL rows.
    const safe = /^[A-Z][A-Z0-9_]+$/.test(error.message);
    console.error(safe ? error.message : 'IMPORT_FAILED: source or database could not be processed');
    process.exitCode = 1;
  } finally { preview?.close(); live?.close(); }
}
