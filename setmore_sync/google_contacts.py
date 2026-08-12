import os
import time
from pathlib import Path

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

PEOPLE_API = "https://people.googleapis.com/v1"
SCOPES = ["https://www.googleapis.com/auth/contacts"]
SEARCH_READ_MASK = (
    "metadata,names,emailAddresses,phoneNumbers,addresses,clientData,userDefined"
)


class GoogleError(RuntimeError):
    pass


class GoogleContacts:
    def __init__(self, client_secret_file: str, token_path: Path, *, retries: int = 4):
        self.client_secret_file = client_secret_file
        self.token_path = token_path
        self.retries = retries
        self._creds = self._load_credentials()

    # ---- auth ----

    def _load_credentials(self) -> Credentials:
        creds = None
        if self.token_path.exists():
            creds = Credentials.from_authorized_user_file(str(self.token_path), SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                if not os.path.exists(self.client_secret_file):
                    raise GoogleError(
                        f"Google client secret not found at {self.client_secret_file}. "
                        "Follow the README to create it, then run: setmore-sync setup-google"
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secret_file, SCOPES
                )
                creds = flow.run_local_server(port=0)
            self.token_path.parent.mkdir(parents=True, exist_ok=True)
            self.token_path.write_text(creds.to_json())
        return creds

    def _request(self, method: str, path: str, params: dict | None = None, body=None) -> dict:
        url = f"{PEOPLE_API}{path}"
        for attempt in range(self.retries):
            if not self._creds.valid:
                self._creds.refresh(Request())
            resp = requests.request(
                method,
                url,
                params=params,
                json=body,
                headers={
                    "Authorization": f"Bearer {self._creds.token}",
                    "Content-Type": "application/json",
                },
                timeout=60,
            )
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            if resp.status_code == 401 and self._creds.refresh_token:
                self._creds.refresh(Request())
                self.token_path.write_text(self._creds.to_json())
                continue
            if resp.status_code != 200:
                raise GoogleError(f"Google {path} failed (HTTP {resp.status_code}): {resp.text[:400]}")
            return resp.json()
        raise GoogleError("Google API rate limited after retries")

    # ---- warmup ----

    def warmup_search(self):
        """Search cache warmup; empty query is required before reliable search."""
        try:
            self._request("GET", "/people:searchContacts", params={"query": ""})
        except GoogleError:
            pass

    # ---- search ----

    def search_contacts(self, query: str) -> list[dict]:
        resp = self._request(
            "GET",
            "/people:searchContacts",
            params={
                "query": query,
                "readMask": SEARCH_READ_MASK,
                "pageSize": "30",
            },
        )
        return [r.get("person") for r in resp.get("results", []) if r.get("person")]

    # ---- read ----

    def get_batch(self, resource_names: list[str]) -> list[dict]:
        if not resource_names:
            return []
        persons = []
        for i in range(0, len(resource_names), 200):
            chunk = resource_names[i : i + 200]
            resp = self._request(
                "GET",
                "/people:batchGet",
                params={
                    "resourceNames": chunk,
                    "personFields": SEARCH_READ_MASK,
                },
            )
            persons.extend(r.get("person") for r in resp.get("responses", []) if r.get("person"))
        return persons

    # ---- write ----

    def batch_create(self, persons: list[dict]) -> tuple[list[dict], list[dict]]:
        """Create up to 200 contacts. Returns (created, errors).

        Group membership cannot be set at create time, so it is applied
        afterwards via contactGroups.members.modify.
        """
        group_resource: str | None = None
        for p in persons:
            memberships = p.get("contactGroupMemberships") or []
            if memberships:
                group_resource = memberships[0].get("contactGroupResourceName")
                break
        payload = [
            {"contactPerson": {k: v for k, v in p.items() if k != "contactGroupMemberships"}}
            for p in persons
        ]
        resp = self._request(
            "POST",
            "/people:batchCreateContacts",
            body={
                "contacts": payload,
                "readMask": SEARCH_READ_MASK,
            },
        )
        created = []
        for cp in resp.get("createdPeople", []):
            person = cp.get("person") or {}
            created.append(
                {
                    "resource_name": person.get("resourceName"),
                    "person": person,
                    "status": cp.get("status"),
                }
            )
        errors = resp.get("batchCreateContactsErrorDetails", {}).get("errors", [])
        if created and group_resource:
            resource_names = [
                c["resource_name"] for c in created if c.get("resource_name")
            ]
            self.add_to_group(group_resource, resource_names)
        return created, errors

    def add_to_group(self, group_resource: str, resource_names: list[str]) -> None:
        """Add contacts to a group via contactGroups.members.modify."""
        if not resource_names:
            return
        for i in range(0, len(resource_names), 200):
            chunk = resource_names[i : i + 200]
            path = group_resource
            if path.startswith("contactGroups/"):
                path = path[len("contactGroups/"):]
            self._request(
                "POST",
                f"/contactGroups/{path}/members:modify",
                body={"resourceNamesToAdd": chunk},
            )

    def batch_update(self, contacts: list[dict]) -> list[dict]:
        """contacts: [{resource_name, etag, person}]. Returns statuses."""
        payload = {}
        for c in contacts:
            payload[c["resource_name"]] = {"etag": c["etag"], **c["person"]}
        resp = self._request(
            "POST",
            "/people:batchUpdateContacts",
            body={
                "contacts": payload,
                "updateMask": "names,emailAddresses,phoneNumbers,addresses,clientData,userDefined",
                "readMask": SEARCH_READ_MASK,
            },
        )
        return resp.get("updateContacts", [])

    # ---- groups ----

    def get_or_create_group(self, name: str) -> str:
        resp = self._request("GET", "/contactGroups")
        for group in resp.get("contactGroups", []):
            if group.get("name") == name:
                return group["resourceName"]
        created = self._request(
            "POST", "/contactGroups", body={"contactGroup": {"name": name}}
        )
        return created["resourceName"]
