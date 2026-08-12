# setmore-sync

Local app that syncs your **Setmore customers → Google Contacts** using the
**official Setmore developer API** (Option C from the research notes). Fully
standalone — it talks only to Setmore and Google directly, no third-party
automation service. Runs on your Mac via `launchd`.

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

## Schedule it (launchd)

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
