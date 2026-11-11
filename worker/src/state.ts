export interface Mapping {
  resourceName: string;
  contentHash: string;
}

const LOCK_NAME = "sync";
const RERUN_KEY = "rerun_requested";

/** D1 store mapping Setmore customer keys to Google contacts (same schema as the CLI). */
export class State {
  constructor(private readonly db: D1Database) {}

  async loadAll(): Promise<Map<string, Mapping>> {
    const { results } = await this.db
      .prepare("SELECT setmore_key, resource_name, content_hash FROM contacts")
      .all<{ setmore_key: string; resource_name: string; content_hash: string }>();
    return new Map(
      results.map((r) => [r.setmore_key, { resourceName: r.resource_name, contentHash: r.content_hash }]),
    );
  }

  async upsertMany(rows: { key: string; resourceName: string; contentHash: string }[]): Promise<void> {
    if (!rows.length) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO contacts (setmore_key, resource_name, content_hash, last_synced_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(setmore_key) DO UPDATE SET
         resource_name = excluded.resource_name,
         content_hash = excluded.content_hash,
         last_synced_at = excluded.last_synced_at`,
    );
    await this.db.batch(rows.map((r) => stmt.bind(r.key, r.resourceName, r.contentHash, now)));
  }

  async count(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ---- lock: one sync at a time across cron, email and HTTP triggers ----

  async acquireLock(owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO locks (name, owner, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE locks.expires_at < ?4`,
      )
      .bind(LOCK_NAME, owner, now + ttlMs, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseLock(owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM locks WHERE name = ?1 AND owner = ?2").bind(LOCK_NAME, owner).run();
  }

  /** Called when a trigger arrives while another sync is running. */
  async requestRerun(): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`,
      )
      .bind(RERUN_KEY)
      .run();
  }

  /** Atomically clears the rerun flag; true if one was pending. */
  async takeRerunRequest(): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE meta SET value = '0' WHERE key = ?1 AND value = '1'")
      .bind(RERUN_KEY)
      .run();
    return result.meta.changes === 1;
  }
}
