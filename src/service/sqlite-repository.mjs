import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export class SqliteRepository {
  constructor(file) {
    this.depth = 0;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        let version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 4) throw new Error('UNSUPPORTED_SCHEMA');
        for (let next = version + 1; next <= 4; next++) {
          this.db.exec(readFileSync(new URL('./migrations/' + String(next).padStart(3, '0') + '.sql', import.meta.url), 'utf8'));
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(action) {
    const level = this.depth++;
    const savepoint = 'nested_' + level;
    try {
      this.db.exec(level ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    } catch (error) { this.depth--; throw error; }
    try {
      const result = action();
      if (result && typeof result.then === 'function') throw new Error('ASYNC_TRANSACTION_NOT_ALLOWED');
      this.db.exec(level ? 'RELEASE ' + savepoint : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(level ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK');
      if (level) this.db.exec('RELEASE ' + savepoint);
      throw error;
    } finally { this.depth--; }
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  close() { this.db.close(); }
}
