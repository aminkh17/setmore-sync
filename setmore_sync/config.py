import os
from pathlib import Path

import yaml

DEFAULT_STATE_DIR = Path.home() / ".setmore-sync"


class Config:
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.state_dir = Path(
            os.environ.get("SETMORE_SYNC_STATE_DIR", DEFAULT_STATE_DIR)
        )
        data = {}
        if config_path and config_path.exists():
            data = yaml.safe_load(config_path.read_text()) or {}

        self.setmore_refresh_token = (
            os.environ.get("SETMORE_REFRESH_TOKEN")
            or (data.get("setmore") or {}).get("refresh_token")
            or ""
        ).strip()

        google = data.get("google") or {}
        secret_file = google.get("client_secret_file") or "creds/client_secret.json"
        if not os.path.isabs(secret_file):
            secret_file = str(config_path.parent / secret_file)
        self.google_client_secret_file = os.environ.get(
            "GOOGLE_CLIENT_SECRET_FILE", secret_file
        )

        sync = data.get("sync") or {}
        self.use_contact_group = bool(sync.get("use_contact_group", True))
        self.contact_group_name = str(sync.get("contact_group_name", "Setmore"))
        self.history_start = str(sync.get("history_start", "01-01-2015"))
        self.lookback_days = int(sync.get("lookback_days", 7))

        self.db_path = self.state_dir / "state.db"
        self.google_token_path = self.state_dir / "google_token.json"
        self.state_dir.mkdir(parents=True, exist_ok=True)

    @property
    def has_setmore_credentials(self) -> bool:
        return bool(self.setmore_refresh_token)

    @property
    def has_google_credentials(self) -> bool:
        return os.path.exists(self.google_client_secret_file)


def load_config(config_path: Path) -> Config:
    return Config(config_path)
