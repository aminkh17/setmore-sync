# setmore-sync

Syncs your **Setmore customers → Google Contacts** (one way) using the
**official Setmore developer API** and the Google People API. It talks only to
Setmore and Google directly, with no third-party automation service.

It runs in two places that share the same logic:

- **Cloudflare Worker** (`worker/`, the main deployment): runs automatically
  every 30 minutes and whenever a Setmore booking email reaches a dedicated
  address on your domain. See [Cloudflare Worker](#cloudflare-worker).
- **Python CLI** (`setmore_sync/`): for one-time Google sign-in, local
  inspection and debugging.

## Prerequisites

- A **Setmore Pro** account with **API access** approved by
  `api@setmore.com` — you received a **refresh token** by email (that's your
  credential; it's permanent).
- A Google Cloud project with the **People API** enabled and an OAuth client —
  one-time setup, ~10 min (step 1 below).
- Python 3.10+.

## How it works

```
   Setmore                          local app                          Google
 ─────────────────           ──────────────────────          ────────────────────
 Pro account +                1. exchange refresh token
 refresh token                → access token (~7 days)
                              ──────────────────────
                             2. read customers from
                              appointments
                              (customerDetails=true,
                              cursor-paginated, 150/page)
                              ──────────────────────
                             3. compare vs. local SQLite
                              (setmore key → google id
                              + content hash)
                              ──────────────────────
                             4a. new          → batch create (≤200/batch)
                             4b. changed      → batch update
                             4c. existing     → link by email, no duplicate
                              ──────────────────────
                             5. tag with "Setmore" group,
                              store key in clientData
```

Walkthrough:

1. **Authenticate (Setmore).** The permanent refresh token is exchanged for a
   short-lived access token each run.
2. **Pull customers.** There is no "list all customers" endpoint, so customers
   are collected from appointments (`GET /bookingapi/appointments?...&customerDetails=true`).
   The first run backfills all history; later runs look back 7 days
   (`lookback_days`).
3. **Authenticate (Google).** OAuth with the `contacts` scope — you sign in once
   in a browser; the token is stored locally and auto-refreshed.
4. **Reconcile.** A local SQLite database maps each Setmore customer key to its
   Google contact plus a content hash, so:
   - a customer is **created once** (`people:batchCreateContacts`, up to 200/request),
   - a customer whose details changed is **updated** (`people:batchUpdateContacts`),
   - an existing Google contact — from any source — is **matched by email and
     linked** instead of duplicated.
5. **Tag.** New contacts are added to a **"Setmore"** contact group (optional)
   and carry the Setmore customer key in Google's `clientData` field.

Deletions in Setmore are **not** propagated to Google (your address book keeps
history).

## Setup steps

### 0. Install

```bash
cd setmore-sync
python3 -m venv .venv
.venv/bin/pip install -e .
```

### 1. Google Cloud setup (one time, ~10 min)

1. Go to <https://console.cloud.google.com> and **create a project** (e.g.
   `setmore-sync`).
2. **Enable the People API**: search "People API" → Enable.
3. **Configure the OAuth consent screen**:
   - User type: **External**
   - Fill app name + your email → Save.
   - Add yourself as a **test user** (Audience → Test users → Add users).
4. **Create an OAuth client ID**:
   - Credentials → Create credentials → **OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON and save it as
     `setmore-sync/creds/client_secret.json`.

> In "Testing" mode Google tokens expire after 7 days. If that happens, just
> re-run `setmore-sync setup-google`. (Publishing the app requires scope
> verification, which is unnecessary for a personal tool.)

### 2. Set your Setmore refresh token

From the email Setmore support sent you. Either:

```bash
export SETMORE_REFRESH_TOKEN='r1/your-token'
```

or copy `config.example.yaml` to `config.yaml` and fill in `refresh_token`.
(The env var wins; never commit `config.yaml` or your token.)

### 3. Authenticate with Google

```bash
.venv/bin/setmore-sync setup-google
```

A browser opens → sign in with the test-user account → approve the Contacts
scope. A token is saved to `~/.setmore-sync/google_token.json`.

### 4. Verify and sync

```bash
# confirm Setmore token + recent customers
.venv/bin/setmore-sync test-setmore

# see exactly what would happen (no writes)
.venv/bin/setmore-sync run --dry-run

# first real run: backfill all history
.venv/bin/setmore-sync run --full-history

# incremental runs afterwards (new/updated customers only)
.venv/bin/setmore-sync run

# local state
.venv/bin/setmore-sync status
```

## Cloudflare Worker

`worker/` is a TypeScript port of the sync, deployed as the `setmore-sync`
Worker. It runs on three triggers:

| Trigger | When |
| --- | --- |
| Email | Any email to the address routed to the Worker by Cloudflare Email Routing (e.g. `setmore-sync@your-domain.com`) |
| Cron | Every 30 minutes, as a backup and to catch edited customer details |
| HTTP | `POST https://setmore-sync.<your-subdomain>.workers.dev/run` with the sync token |

Setmore can't send booking notifications to an extra address, so forward them
with a Gmail filter: match Setmore's booking emails → **Forward it to** the
Worker's address. Gmail first sends a confirmation email to that address; the
Worker writes it to its logs (`gmail_forwarding_confirmation`) so you can open
the confirmation link.

- State lives in the D1 database `setmore-sync` (same schema as the CLI's
  `state.db`). Content hashes are byte-identical to the Python version.
- A lease lock in D1 ensures only one sync runs at a time. A trigger that
  arrives mid-sync queues one follow-up run.
- Logs: Cloudflare dashboard → Workers → setmore-sync → Logs, or `npm run tail`.

> Once the Worker is live, don't use `setmore-sync run` from the CLI to write
> contacts: its local `state.db` no longer sees what the Worker created, so it
> could create duplicates. CLI `--dry-run` and `test-setmore` are still fine.

### Manual run

```bash
TOKEN=$(cat ~/.setmore-sync/worker_sync_token)
URL=https://setmore-sync.<your-subdomain>.workers.dev/run
curl -X POST "$URL?dry=1" -H "Authorization: Bearer $TOKEN"   # plan only
curl -X POST "$URL" -H "Authorization: Bearer $TOKEN"         # sync now
curl -X POST "$URL?full=1" -H "Authorization: Bearer $TOKEN"  # backfill all history
```

### Secrets

| Secret | Source |
| --- | --- |
| `SETMORE_REFRESH_TOKEN` | Setmore API email |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `npm run push-google-token` (reads `~/.setmore-sync/google_token.json`) |
| `SYNC_TOKEN` | Random; local copy in `~/.setmore-sync/worker_sync_token` |

While the Google OAuth app is in **Testing** mode, its refresh token expires
after 7 days. Publish the app (OAuth consent screen → **Publish app**) so it
doesn't expire. After publishing, or whenever Google sign-in fails:

```bash
.venv/bin/setmore-sync setup-google --force
cd worker && npm run push-google-token
```

### Deploying changes

```bash
cd worker
npm install
npm run typecheck
npm run deploy
```

`worker/wrangler.jsonc` holds your account-specific D1 database ID, so it is
git-ignored. `worker/wrangler.example.jsonc` is the committed template; keep
the two in sync when you change triggers or vars.

### First-time setup

```bash
cd worker && npm install
npx wrangler d1 create setmore-sync           # note the database_id
cp wrangler.example.jsonc wrangler.jsonc      # paste the database_id in
npm run db:migrate
npm run import-local-state                    # optional: copy the CLI's state.db rows
npm run deploy
npm run push-google-token                     # after setmore-sync setup-google
npx wrangler secret put SETMORE_REFRESH_TOKEN
openssl rand -hex 32 > ~/.setmore-sync/worker_sync_token
printf '{"SYNC_TOKEN":"%s"}' "$(cat ~/.setmore-sync/worker_sync_token)" | npx wrangler secret bulk
```

Then, in the Cloudflare dashboard (Email → Email Routing → Routing rules), add a
custom address that sends to the Worker `setmore-sync`.

## Schedule it locally (launchd)

Only needed if you're not using the Cloudflare Worker.
Edit `launchd/com.setmore-sync.plist.example` to your paths, then:

```bash
cp launchd/com.setmore-sync.plist.example ~/Library/LaunchAgents/com.setmore-sync.plist
# edit paths + SETMORE_REFRESH_TOKEN in the copy
launchctl load ~/Library/LaunchAgents/com.setmore-sync.plist
```

Or run in the foreground on a timer:

```bash
.venv/bin/setmore-sync run --loop 30   # every 30 minutes
```

## Config options

See `config.example.yaml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `setmore.refresh_token` | — | Your Setmore API refresh token |
| `google.client_secret_file` | `creds/client_secret.json` | OAuth client JSON |
| `sync.use_contact_group` | `true` | Put contacts in a group |
| `sync.contact_group_name` | `Setmore` | Group name |
| `sync.history_start` | `01-01-2015` | First-run backfill start (dd-mm-yyyy) |
| `sync.lookback_days` | `7` | Incremental look-back window |

## Limitations

- Customers are found via **appointments**, so a customer with no appointments
  ever won't appear. (Setmore's API exposes no customer-list endpoint.)
- Field mapping: first/last name, email, phone (country code + number), and
  Setmore custom fields → Google `userDefined`.
- Setmore is the source of truth: when a customer changes, the Google contact's
  mapped fields are overwritten (other fields you added by hand are kept).
