from datetime import date, datetime, timedelta, timezone

from .config import Config
from .google_contacts import GoogleContacts
from .model import (
    build_person,
    client_data_key,
    emails_of,
    google_hash,
    is_contact_source,
    is_empty_customer,
    setmore_hash,
)
from .setmore import SetmoreClient
from .state import State


def date_windows(full_history: bool, history_start: str, lookback_days: int) -> list[tuple[str, str]]:
    today = date.today()
    if full_history:
        start = datetime.strptime(history_start, "%d-%m-%Y").date()
    else:
        start = today - timedelta(days=lookback_days)
    end = today + timedelta(days=730)

    windows: list[tuple[str, str]] = []
    for year in range(start.year, end.year + 1):
        window_start = max(start, date(year, 1, 1))
        window_end = min(end, date(year, 12, 31))
        if window_start > window_end:
            continue
        windows.append(
            (window_start.strftime("%d-%m-%Y"), window_end.strftime("%d-%m-%Y"))
        )
    return windows


def fetch_all_customers(setmore: SetmoreClient, cfg: Config, full_history: bool) -> list[dict]:
    customers: dict[str, dict] = {}
    for start, end in date_windows(full_history, cfg.history_start, cfg.lookback_days):
        for cust in setmore.fetch_customers(start, end):
            customers[cust["key"]] = cust
    return list(customers.values())


def _matching_contact(search_results: list[dict], email: str) -> dict | None:
    for person in search_results:
        if is_contact_source(person) and email in emails_of(person):
            return person
    return None


def run(cfg: Config, *, dry_run: bool = False, full_history: bool = False) -> dict:
    if not cfg.has_setmore_credentials:
        raise SystemExit(
            "Setmore refresh token missing. Set SETMORE_REFRESH_TOKEN or add it to config.yaml."
        )

    setmore = SetmoreClient(cfg.setmore_refresh_token)
    customers = fetch_all_customers(setmore, cfg, full_history)
    print(f"Setmore: {len(customers)} unique customer(s) from appointments.")

    google: GoogleContacts | None = None
    group_resource: str | None = None
    if cfg.has_google_credentials:
        google = GoogleContacts(cfg.google_client_secret_file, cfg.google_token_path)
        google.warmup_search()
        if cfg.use_contact_group and not dry_run:
            group_resource = google.get_or_create_group(cfg.contact_group_name)

    state = State(cfg.db_path)
    summary = {
        "fetched": len(customers),
        "unchanged": 0,
        "to_update": 0,
        "linked": 0,
        "to_create": 0,
        "skipped_empty": 0,
        "errors": [],
    }

    creates: list[dict] = []
    create_hashes: dict[str, str] = {}
    update_targets: dict[str, dict] = {}  # resource_name -> setmore customer

    for cust in customers:
        key = cust["key"]
        content_hash = setmore_hash(cust)

        if is_empty_customer(cust):
            summary["skipped_empty"] += 1
            continue

        mapped = state.get(key)
        if mapped:
            if mapped["content_hash"] != content_hash:
                update_targets[mapped["resource_name"]] = cust
                summary["to_update"] += 1
            else:
                summary["unchanged"] += 1
            continue

        # Not mapped yet: link an existing Google contact by email to avoid duplicates.
        email = cust.get("email_id") or ""
        if google and email:
            existing = _matching_contact(
                google.search_contacts(email), email.strip().lower()
            )
            if existing:
                resource_name = existing["resourceName"]
                if google_hash(existing) != content_hash:
                    update_targets[resource_name] = cust
                    summary["to_update"] += 1
                if group_resource and not dry_run:
                    google.add_to_group(group_resource, [resource_name])
                state.upsert(key, resource_name, google_hash(existing))
                summary["linked"] += 1
                continue

        creates.append(build_person(cust, group_resource, include_group=bool(group_resource)))
        create_hashes[key] = content_hash
        summary["to_create"] += 1

    print(
        f"Plan: {summary['unchanged']} unchanged, {summary['to_update']} update, "
        f"{summary['linked']} link to existing, {summary['to_create']} create, "
        f"{summary['skipped_empty']} skipped (no name/email/phone)."
    )

    if dry_run:
        _print_dry_run(creates, update_targets, google)
        state.close()
        return summary

    _execute_creates(google, creates, create_hashes, state, summary)
    _execute_updates(google, update_targets, state, summary)

    state.close()
    print(
        f"Done. Created {summary['to_create']}, updated {summary['to_update']}, "
        f"linked {summary['linked']}."
    )
    return summary


def _print_dry_run(creates: list[dict], update_targets: dict, google: GoogleContacts | None):
    for person in creates[:20]:
        names = person.get("names") or [{}]
        emails = person.get("emailAddresses") or [{}]
        label = names[0].get("givenName", "") + " " + names[0].get("familyName", "")
        print(f"  CREATE  {label.strip() or '(no name)'} <{emails[0].get('value', '')}>")
    if len(creates) > 20:
        print(f"  ... and {len(creates) - 20} more")
    if google is None:
        print("  (no Google credentials -> existing contacts not searched; all treated as new)")


def _execute_creates(google: GoogleContacts, creates: list[dict],
                     create_hashes: dict, state: State, summary: dict):
    if not creates:
        return
    for i in range(0, len(creates), 200):
        chunk = creates[i : i + 200]
        created, errors = google.batch_create(chunk)
        for entry in created:
            person = entry.get("person") or {}
            key = client_data_key(person)
            resource_name = person.get("resourceName")
            if key and resource_name:
                state.upsert(key, resource_name, create_hashes[key])
        for error in errors:
            summary["errors"].append(error)


def _execute_updates(google: GoogleContacts, update_targets: dict,
                     state: State, summary: dict):
    if not update_targets:
        return
    resource_names = list(update_targets.keys())
    persons_by_name = {
        p.get("resourceName"): p for p in google.get_batch(resource_names)
    }
    for rn, cust in update_targets.items():
        person = persons_by_name.get(rn)
        if not person:
            summary["errors"].append(f"No Google person found for {rn}")
            continue
        try:
            google.batch_update(
                [{
                    "resource_name": rn,
                    "etag": person.get("etag"),
                    "person": build_person(cust, include_group=False),
                }]
            )
            state.upsert(cust["key"], rn, setmore_hash(cust))
        except Exception as exc:  # noqa: BLE001 - report and continue
            summary["errors"].append(str(exc))
