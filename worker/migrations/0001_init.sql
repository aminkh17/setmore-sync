-- Same contacts/meta schema as the Python CLI's ~/.setmore-sync/state.db,
-- so its rows can be imported as-is.
CREATE TABLE IF NOT EXISTS contacts (
    setmore_key    TEXT PRIMARY KEY,
    resource_name  TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Lease lock so overlapping triggers (several booking emails, cron) never
-- run two syncs at once and create duplicate contacts.
CREATE TABLE IF NOT EXISTS locks (
    name       TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
