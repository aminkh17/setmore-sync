// Push the Google OAuth credentials saved by `setmore-sync setup-google` to the
// Worker's secrets. Re-run after every `setup-google --force`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.SETMORE_SYNC_STATE_DIR || join(homedir(), ".setmore-sync");
const tokenPath = join(stateDir, "google_token.json");
const token = JSON.parse(readFileSync(tokenPath, "utf8"));

const secrets = {
  GOOGLE_CLIENT_ID: token.client_id,
  GOOGLE_CLIENT_SECRET: token.client_secret,
  GOOGLE_REFRESH_TOKEN: token.refresh_token,
};
const missing = Object.entries(secrets).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`${tokenPath} is missing: ${missing.join(", ")}. Run: setmore-sync setup-google --force`);
  process.exit(1);
}

const result = spawnSync("npx", ["wrangler", "secret", "bulk"], {
  input: JSON.stringify(secrets),
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(result.status ?? 1);
