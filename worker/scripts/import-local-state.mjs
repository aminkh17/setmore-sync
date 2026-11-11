// One-off: copy the Python CLI's sync records (~/.setmore-sync/state.db) into D1,
// so the Worker recognises contacts that were already synced from this Mac.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.SETMORE_SYNC_STATE_DIR || join(homedir(), ".setmore-sync");
const dbPath = join(stateDir, "state.db");

const rows = JSON.parse(
  execFileSync("sqlite3", [
    "-json",
    dbPath,
    "SELECT setmore_key, resource_name, content_hash, last_synced_at FROM contacts",
  ]).toString() || "[]",
);
if (!rows.length) {
  console.log(`No rows in ${dbPath}; nothing to import.`);
  process.exit(0);
}

const quote = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
const sql = rows
  .map(
    (r) =>
      `INSERT OR REPLACE INTO contacts (setmore_key, resource_name, content_hash, last_synced_at) VALUES (${[
        r.setmore_key,
        r.resource_name,
        r.content_hash,
        r.last_synced_at,
      ]
        .map(quote)
        .join(", ")});`,
  )
  .join("\n");

const dir = mkdtempSync(join(tmpdir(), "setmore-sync-"));
const file = join(dir, "import.sql");
try {
  writeFileSync(file, sql + "\n");
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "setmore-sync", "--remote", `--file=${file}`], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Imported ${rows.length} contact mapping(s) from ${dbPath}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
