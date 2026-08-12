import time

import requests

BASE_URL = "https://developer.setmore.com/api/v1"


class SetmoreError(RuntimeError):
    pass


class SetmoreClient:
    def __init__(self, refresh_token: str, *, timeout: int = 30, retries: int = 4):
        self.refresh_token = refresh_token
        self.timeout = timeout
        self.retries = retries
        self._access_token = None

    # ---- auth ----

    def _get_access_token(self) -> str:
        resp = requests.get(
            f"{BASE_URL}/o/oauth2/token",
            params={"refreshToken": self.refresh_token},
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise SetmoreError(
                f"Setmore token exchange failed (HTTP {resp.status_code}): {resp.text[:300]}"
            )
        try:
            return resp.json()["data"]["token"]["access_token"]
        except (KeyError, TypeError, ValueError):
            raise SetmoreError(f"Unexpected token response: {resp.text[:300]}")

    def _headers(self) -> dict:
        if self._access_token is None:
            self._access_token = self._get_access_token()
        return {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }

    # ---- request ----

    def _request(self, method: str, path: str, params: dict | None = None) -> dict:
        url = f"{BASE_URL}{path}"
        for attempt in range(self.retries):
            resp = requests.request(
                method, url, params=params, headers=self._headers(), timeout=self.timeout
            )
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            if resp.status_code != 200:
                raise SetmoreError(f"Setmore {path} failed (HTTP {resp.status_code}): {resp.text[:300]}")
            return resp.json()
        raise SetmoreError("Setmore API rate limited after retries")

    # ---- data ----

    def fetch_customers(
        self, start_date: str, end_date: str, page_size: int = 150
    ) -> list[dict]:
        """Enumerate customers by walking appointments (customerDetails=true).

        The Setmore API has no "list all customers" endpoint, so customers are
        collected from their appointments. start_date/end_date use dd-mm-yyyy.
        """
        customers: dict[str, dict] = {}
        cursor: str | None = None
        pages = 0
        while True:
            params = {
                "startDate": start_date,
                "endDate": end_date,
                "customerDetails": "true",
            }
            if cursor:
                params["cursor"] = cursor

            payload = self._request("GET", "/bookingapi/appointments", params=params)
            data = payload.get("data") or {}
            appointments = data.get("appointments") or []
            cursor = data.get("cursor")
            pages += 1

            for appt in appointments:
                cust = appt.get("customer")
                if not cust or not cust.get("key"):
                    continue
                key = cust["key"]
                # later appointments may carry more complete customer info
                customers[key] = cust

            if not cursor or not appointments:
                break
            time.sleep(0.4)

        return list(customers.values())
