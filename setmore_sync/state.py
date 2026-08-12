import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class State:
    """Local SQLite store mapping Setmore customer keys to Google contacts.

    A content hash lets the sync detect when a Setmore customer's details
    changed so it can update the Google contact instead of duplicating it.
    """

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(str(db_path))
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS contacts (
                setmore_key   TEXT PRIMARY KEY,
                resource_name TEXT NOT NULL,
                content_hash  TEXT NOT NULL,
                last_synced_at TEXT
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        self.conn.commit()

    def close(self):
        self.conn.close()

    # ---- contacts mapping ----

    def get(self, setmore_key: str):
        row = self.conn.execute(
            "SELECT resource_name, content_hash FROM contacts WHERE setmore_key = ?",
            (setmore_key,),
        ).fetchone()
        if row is None:
            return None
        return {"resource_name": row[0], "content_hash": row[1]}

    def upsert(self, setmore_key: str, resource_name: str, content_hash: str):
        self.conn.execute(
            """
            INSERT INTO contacts (setmore_key, resource_name, content_hash, last_synced_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(setmore_key) DO UPDATE SET
                resource_name = excluded.resource_name,
                content_hash = excluded.content_hash,
                last_synced_at = excluded.last_synced_at
            """,
            (setmore_key, resource_name, content_hash, _now_iso()),
        )
        self.conn.commit()

    def all(self):
        rows = self.conn.execute(
            "SELECT setmore_key, resource_name, content_hash FROM contacts"
        ).fetchall()
        return [
            {"setmore_key": k, "resource_name": r, "content_hash": h}
            for k, r, h in rows
        ]

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]

    # ---- meta ----

    def get_meta(self, key: str):
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str):
        self.conn.execute(
            """
            INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        self.conn.commit()
