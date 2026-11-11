---
name: setmore-sync
description: Use when working on, debugging, or extending the setmore-sync project — a Python CLI that syncs Setmore customers into Google Contacts via the Setmore API and Google People API. Covers architecture, CLI commands, API endpoints, sync logic, and the API gotchas that keep biting (batchCreate group memberships, members:modify path, batchGet endpoint, link-vs-hash bug). Trigger on any task involving setmore, google contacts, people api, sync runs, dry-run, OAuth, launchd, or the SQLite state.
---

# setmore-sync

Local Python app syncing **Setmore customers → Google Contacts** using the official
Setmore developer API and Google People API. Replaces an old Zapier flow; talks
only to Setmore and Google directly. Deployed as a **Cloudflare Worker**
(`worker/`, TypeScript port), with the Python CLI kept for Google sign-in,
dry-runs and debugging.

## Cloudflare Worker (`worker/`)

- Worker `setmore-sync`, D1 database `setmore-sync`
  (binding `DB`, same `contacts`/`meta` schema as the CLI plus a `locks` table).
  `worker/wrangler.jsonc` (real database ID) is git-ignored; edit
  `worker/wrangler.example.jsonc` alongside it. This repo is public: never
  commit account IDs, domains, Worker URLs, tokens or customer data.
- Triggers: email to an Email Routing address on the owner's domain (Setmore
  booking emails forwarded by a Gmail filter), cron `*/30 * * * *`, and
  `POST /run` (Bearer `SYNC_TOKEN`; `?dry=1`, `?full=1`). Gmail forwarding
  confirmations (`forwarding-noreply@google.com`) are logged, not synced.
- `src/model.ts` must keep hashes **byte-identical** to `model.py`
  (`json.dumps(sort_keys=True)` separators + `ensure_ascii` escaping, Python
  `str()`/truthiness for custom-field values). If either side changes, change
  both and re-verify against real data before deploying, or every contact will
  be rewritten.
- One sync at a time: D1 lease lock (`locks` table, 5 min TTL); a trigger that
  arrives mid-sync sets `meta.rerun_requested` and the running sync reruns once.
- After creating contacts, D1 state is written **before** group membership, so
  a failure can't lead to duplicates on retry.
- Secrets: `SETMORE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`, `SYNC_TOKEN`. `npm run push-google-token` copies the
  Google ones from `~/.setmore-sync/google_token.json`.
- Commands (in `worker/`): `npm run typecheck`, `npm run deploy`, `npm run tail`,
  `npm run db:migrate`, `npm run import-local-state`.
- Don't run the CLI's `run` (write mode) once the Worker is live: its local
  `state.db` diverges from D1 and can create duplicates.

## Architecture

```
Setmore (Pro + refresh token)
   │  1. exchange refresh token → access token (~7 days)
   ▼
setmore_sync.setmore.SetmoreClient
   │  2. enumerate customers from appointments
   │     (customerDetails=true, cursor-paginated, 150/page)
   ▼
setmore_sync.sync.run()
   │  3. reconcile vs SQLite state (~/.setmore-sync/state.db)
   │     setmore key → google resource name + content hash
   │  4a. new      → batch create
   │  4b. changed  → batch update
   │  4c. existing → link by email (no duplicate)
   │  5. tag with "Setmore" contact group, key in clientData
   ▼
setmore_sync.google_contacts.GoogleContacts
   ▼
Google People API
```

Deletions in Setmore are **not** propagated to Google by design.

## Module map

| File | Responsibility |
| --- | --- |
| `setmore_sync/cli.py` | argparse CLI: `setup-google`, `test-setmore`, `run`, `status` |
| `setmore_sync/config.py` | `config.yaml` + env vars; env vars win. State dir defaults to `~/.setmore-sync`, override with `SETMORE_SYNC_STATE_DIR` |
| `setmore_sync/setmore.py` | Setmore auth + `fetch_customers(start_date, end_date)` |
| `setmore_sync/google_contacts.py` | OAuth + all People API calls |
| `setmore_sync/model.py` | field mapping, content hashing, person build (names/emails/phones/addresses/clientData/userDefined) |
| `setmore_sync/state.py` | SQLite `contacts` (setmore_key→resource_name, content_hash) + `meta` tables |
| `setmore_sync/sync.py` | orchestration, planning, dedup, link-by-email |
| `config.example.yaml` | config keys reference; copy to `config.yaml` for real values |

## CLI

```bash
.venv/bin/setmore-sync setup-google [--force]   # one-time OAuth (opens browser)
.venv/bin/setmore-sync test-setmore [--days 90] # verify Setmore token + list customers
.venv/bin/setmore-sync run [--dry-run] [--full-history] [--lookback-days N] [--loop MIN]
.venv/bin/setmore-sync status                   # show local sync state
```

- First real run: `run --full-history` (backfills from `history_start`).
- Incremental runs afterwards: plain `run` (looks back `lookback_days`, default 7).
- `--dry-run` prints a plan and writes nothing (but still does Google search warmup).
- `--loop MIN` repeats in-process; launchd plist example in `launchd/`.

Config is resolved per-run from `config.yaml` or env
(`SETMORE_REFRESH_TOKEN`, `GOOGLE_CLIENT_SECRET_FILE`). Never commit `config.yaml`,
`creds/`, or `.env` — they are gitignored.

## Development workflow

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/setmore-sync test-setmore          # Setmore credential OK?
.venv/bin/setmore-sync run --dry-run         # inspect plan, no writes
.venv/bin/setmore-sync run --full-history    # real backfill
.venv/bin/setmore-sync run                   # incremental
.venv/bin/setmore-sync status                # verify state mapping
```

There are no tests in the repo; verification is via dry-run + status +
inspecting Google Contacts. Always sanity-check the generated plan line
(`unchanged / update / link / create / skipped`) before and after changes.

## Key API facts (verified against live endpoints)

### Setmore (`https://developer.setmore.com/api/v1`)
- No "list all customers" endpoint. Customers are collected from
  `GET /bookingapi/appointments` with `customerDetails=true`. Parameters:
  `startDate`, `endDate` (both `dd-mm-yyyy`), optional `cursor`. Paginated at
  150/page via `data.cursor`; loop until cursor is empty or no appointments.
- Token exchange: `GET /o/oauth2/token?refreshToken=<permanent>`. Response:
  `data.token.access_token`. Access token lasts ~7 days; refresh token is permanent.
- Customer dict has `key`, `first_name`, `last_name`, `email_id`, `cell_phone`,
  `country_code`, `address`, `additional_fields`. Later appointments may carry
  more complete customer info — later wins (`customers[key] = cust`).

### Google People API (`https://people.googleapis.com/v1`)
- OAuth scope `https://www.googleapis.com/auth/contacts`. Token stored at
  `~/.setmore-sync/google_token.json`, auto-refreshed. In Google **Testing**
  mode the refresh token dies after ~7 days → re-run `setup-google`.
- **GET `/people:searchContacts`** — params `query`, `readMask`, `pageSize`.
  Results in `results[].person`. Call `warmup_search()` (empty query) once at
  startup before relying on search.
- **POST `/people:batchCreateContacts`** — body `{"contacts": [{"contactPerson": p}], "readMask": ...}`.
  **`contactGroupMemberships` is REJECTED here** (400 `Unknown name`). Strip it,
  create, then add to the group via members:modify. Response: `createdPeople[].person`.
- **POST `/people:batchUpdateContacts`** — body
  `{"contacts": {resourceName: {"etag": ..., ...person}}, "updateMask": "names,emailAddresses,phoneNumbers,addresses,clientData,userDefined"}`.
  `contactGroupMemberships` IS accepted here (use to attach groups on update).
  Note the payload is a **map keyed by resource name**, not a list.
- **GET `/people:batchGet`** — this is a **GET with query params**, not a POST
  with a body. `params={"resourceNames": name1}` (repeatable), `personFields`
  required. The path is `/people:batchGet` — NOT `/people:getBatchGet`. Max 200
  names per call. Responses in `responses[].person`.
- **POST `/contactGroups`** — create, body `{"contactGroup": {"name": name}}`.
  Response is a **bare ContactGroup**: read `resourceName` from the top level
  (`created["resourceName"]`), not `created["contactGroup"]`. Names must be unique.
- **GET `/contactGroups`** — list groups; match by `name` to find an existing one.
- **POST `/contactGroups/<group_id>/members:modify`** — body `{"resourceNamesToAdd": [...]}`.
  Path uses the group **id WITHOUT the `contactGroups/` prefix** (strip it from
  `contactGroups/xxx` → `xxx`). Add is idempotent. Member limit 1000 per call.

## Sync logic details (`sync.py`)

- `date_windows()` splits the date range per calendar year to keep Setmore
  requests bounded; `history_start` only matters on `--full-history`.
- Per customer: compute `setmore_hash` (base fields + sorted additional fields).
  - **Already mapped** (state has the key): hash equal → unchanged; different →
    add to `update_targets`.
  - **Unmapped with email**: `search_contacts(email)` → if a CONTACT-source
    person matches the email, **link** it. On link, store
    `google_hash(existing)` in state (NOT the Setmore hash) so a content
    mismatch surfaces as an update on the next run. Also add it to the group.
  - **Otherwise**: append to `creates`.
- `_execute_creates` batches ≤200, maps created `clientData.setmoreKey` back to
  the Setmore key, and upserts state. `create_hashes` maps key → hash.
- `_execute_updates` fetches current people via batchGet (for etags), then
  batchUpdate per person, building persons with `include_group=False` (updates
  don't touch group membership via that path — group attachment happens at
  create/link).
- Empty customers (no name/email/phone) are counted as `skipped` and skipped.

## Field mapping (`model.py`)

- Names: givenName/familyName; email → `emailAddresses` (type other); phone →
  `phoneNumbers` (type mobile); address → `addresses` streetAddress (type home).
- Phone: E.164 from `country_code` + `cell_phone` (strip `+` from country code,
  prepend if phone doesn't already start with `+`).
- `clientData`: `{"key": "setmoreKey", "value": cust["key"]}` — used to
  correlate created contacts back to Setmore keys.
- Setmore `additional_fields` → Google `userDefined` (keys sanitized
  `[^a-zA-Z0-9_]` → `_`).
- `google_hash` reads only mapped fields so Setmore content and Google content
  are comparable.

## Gotchas (each one was a real production bug here)

1. `batchCreateContacts` rejects `contactGroupMemberships` → must call
   `members:modify` after creation.
2. `contactGroups.create` returns the group **unwrapped** (`created["resourceName"]`).
3. `members:modify` path: `/contactGroups/<id-without-prefix>/members:modify`.
4. `people:batchGet` is GET + query params, endpoint is `/people:batchGet`
   (a POST to `/people:getBatchGet` returns HTML 404).
5. Linking must persist `google_hash(existing)`, not the Setmore hash — storing
   the Setmore hash hides real updates and reports false "unchanged".
6. Linked contacts are added to the group at link time; a backfill over all
   mapped resource names brings pre-existing contacts into the group.
7. Google OAuth Testing mode: re-auth (~7 days) via `setup-google`; publishing
   the app avoids this but is unnecessary for a personal tool.
8. State DB stores content hashes of what Google currently holds; any repair
   that changes Google content out-of-band must recompute hashes (`google_hash`)
   or the next run will misjudge unchanged vs update.
