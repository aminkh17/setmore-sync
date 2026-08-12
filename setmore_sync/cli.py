import argparse
import time
from pathlib import Path

from .config import load_config
from .google_contacts import GoogleContacts
from .setmore import SetmoreClient
from .state import State
from .sync import date_windows, fetch_all_customers, run


def _cmd_setup_google(args, cfg):
    if not args.force and cfg.google_token_path.exists():
        print(f"Google token already saved at {cfg.google_token_path}. Use --force to re-auth.")
        return 0
    if args.force and cfg.google_token_path.exists():
        cfg.google_token_path.unlink()
    GoogleContacts(cfg.google_client_secret_file, cfg.google_token_path)
    print(f"Google authenticated. Token saved to {cfg.google_token_path}")
    return 0


def _cmd_test_setmore(args, cfg):
    if not cfg.has_setmore_credentials:
        raise SystemExit("Setmore refresh token missing (SETMORE_REFRESH_TOKEN or config.yaml).")
    client = SetmoreClient(cfg.setmore_refresh_token)
    client._get_access_token()
    print("Setmore token exchange OK.")
    lookback_days = args.days
    start, end = date_windows(False, cfg.history_start, lookback_days)[0]
    customers = fetch_all_customers(client, cfg, False)
    print(f"Found {len(customers)} unique customer(s) in the last {lookback_days} days.")
    for cust in customers[:10]:
        name = (cust.get("first_name") or "") + " " + (cust.get("last_name") or "")
        print(f"  {name.strip() or '(no name)'} <{cust.get('email_id', '')}>")
    return 0


def _cmd_run(args, cfg):
    if args.lookback_days:
        cfg.lookback_days = args.lookback_days
    if args.loop:
        print(f"Looping every {args.loop} minutes. Ctrl+C to stop.")
        while True:
            try:
                run(cfg, dry_run=args.dry_run, full_history=args.full_history)
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                print(f"Sync error: {exc}")
            time.sleep(args.loop * 60)
    run(cfg, dry_run=args.dry_run, full_history=args.full_history)
    return 0


def _cmd_status(args, cfg):
    state = State(cfg.db_path)
    print(f"State database: {cfg.db_path}")
    print(f"Synced contacts: {state.count()}")
    for row in state.all()[:20]:
        print(f"  {row['setmore_key']} -> {row['resource_name']}")
    state.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="setmore-sync",
        description="Sync Setmore customers to Google Contacts.",
    )
    parser.add_argument("--config", default="config.yaml", help="Path to config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("setup-google", help="One-time Google OAuth login (opens a browser).")
    p.add_argument("--force", action="store_true", help="Re-authenticate even if a token exists.")

    p = sub.add_parser("test-setmore", help="Verify the Setmore refresh token and list recent customers.")
    p.add_argument("--days", type=int, default=90)

    p = sub.add_parser("run", help="Sync Setmore customers to Google Contacts.")
    p.add_argument("--dry-run", action="store_true", help="Show what would change without writing.")
    p.add_argument("--full-history", action="store_true", help="Backfill from history_start (first run).")
    p.add_argument("--lookback-days", type=int, help="Override lookback window for incremental runs.")
    p.add_argument("--loop", type=int, default=0, metavar="MIN", help="Repeat every MIN minutes.")

    p = sub.add_parser("status", help="Show local sync state.")

    args = parser.parse_args(argv)
    cfg = load_config(Path(args.config))

    if args.command == "setup-google":
        return _cmd_setup_google(args, cfg)
    if args.command == "test-setmore":
        return _cmd_test_setmore(args, cfg)
    if args.command == "run":
        return _cmd_run(args, cfg)
    if args.command == "status":
        return _cmd_status(args, cfg)
    parser.error("unknown command")
    return 2


def _entrypoint() -> int:
    try:
        return main()
    except SystemExit as exc:
        raise exc
    except Exception as exc:  # noqa: BLE001 - print clean errors on the CLI
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(_entrypoint())
