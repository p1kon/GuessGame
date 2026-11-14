import { randomUUID } from 'node:crypto';

export class PollingLease {
  constructor(repository, { clock = Date.now, duration = 120000 } = {}) {
    this.db = repository; this.clock = clock; this.duration = duration; this.owner = randomUUID();
    this.db.transaction(() => {
      const row = this.current();
      if (row && row.expires > this.clock()) throw new Error('POLLER_ALREADY_RUNNING');
      this.write();
    });
  }
  current() {
    const row = this.db.get("SELECT value FROM telegram_meta WHERE key='polling_lease'");
    return row ? JSON.parse(row.value) : null;
  }
  write() {
    this.db.run("INSERT INTO telegram_meta VALUES ('polling_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({ owner: this.owner, expires: this.clock() + this.duration }));
  }
  assert() {
    const row = this.current();
    if (row?.owner !== this.owner || row.expires <= this.clock()) throw new Error('POLLING_LEASE_LOST');
  }
  renew() { this.db.transaction(() => { this.assert(); this.write(); }); }
  release() {
    this.db.transaction(() => {
      if (this.current()?.owner === this.owner) this.db.run("DELETE FROM telegram_meta WHERE key='polling_lease'");
    });
  }
}
