import hashlib
import json
import re

CLIENT_DATA_KEY = "setmoreKey"


def sanitize_key(key: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]", "_", str(key))


def _hash(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _e164_phone(cust: dict) -> str:
    phone = (cust.get("cell_phone") or "").strip()
    if not phone:
        return ""
    if phone.startswith("+"):
        return phone
    country_code = (cust.get("country_code") or "").strip().lstrip("+")
    if country_code:
        return f"+{country_code}{phone}"
    return phone


def base_fields(cust: dict) -> dict:
    return {
        "first_name": (cust.get("first_name") or "").strip(),
        "last_name": (cust.get("last_name") or "").strip(),
        "email": (cust.get("email_id") or "").strip().lower(),
        "phone": _e164_phone(cust),
        "address": (cust.get("address") or "").strip(),
    }


def additional_fields(cust: dict) -> dict:
    adf = cust.get("additional_fields") or {}
    return {
        sanitize_key(str(k)): str(v)
        for k, v in adf.items()
        if str(v or "").strip()
    }


def setmore_hash(cust: dict) -> str:
    return _hash({"base": base_fields(cust), "additional": additional_fields(cust)})


def _google_names(person: dict) -> dict:
    name = (person.get("names") or [{}])[0]
    return {
        "given": (name.get("givenName") or "").strip(),
        "family": (name.get("familyName") or "").strip(),
    }


def google_hash(person: dict) -> str:
    n = _google_names(person)
    email = (person.get("emailAddresses") or [{}])[0].get("value", "").strip().lower()
    phone = (person.get("phoneNumbers") or [{}])[0].get("value", "").strip()
    address = (person.get("addresses") or [{}])[0].get("streetAddress", "").strip()
    additional = {
        ud.get("key", ""): str(ud.get("value", ""))
        for ud in person.get("userDefined") or []
        if ud.get("key") and str(ud.get("value", "")).strip()
    }
    base = {
        "first_name": n["given"],
        "last_name": n["family"],
        "email": email,
        "phone": phone,
        "address": address,
    }
    return _hash({"base": base, "additional": additional})


def emails_of(person: dict) -> set[str]:
    return {e.get("value", "").strip().lower() for e in person.get("emailAddresses") or []}


def is_contact_source(person: dict) -> bool:
    for source in (person.get("metadata") or {}).get("sources", []):
        if source.get("type") == "CONTACT":
            return True
    return False


def client_data_key(person: dict) -> str | None:
    for entry in person.get("clientData") or []:
        if entry.get("key") == CLIENT_DATA_KEY and entry.get("value"):
            return entry["value"]
    return None


def build_person(cust: dict, group_resource_name: str | None = None,
                 include_group: bool = False) -> dict:
    base = base_fields(cust)
    person: dict = {}

    if base["first_name"]:
        name: dict = {"givenName": base["first_name"]}
        if base["last_name"]:
            name["familyName"] = base["last_name"]
        person["names"] = [name]

    if base["email"]:
        person["emailAddresses"] = [{"value": base["email"], "type": "other"}]
    if base["phone"]:
        person["phoneNumbers"] = [{"value": base["phone"], "type": "mobile"}]
    if base["address"]:
        person["addresses"] = [{"streetAddress": base["address"], "type": "home"}]

    person["clientData"] = [{"key": CLIENT_DATA_KEY, "value": cust["key"]}]

    additional = additional_fields(cust)
    if additional:
        person["userDefined"] = [
            {"key": k, "value": v} for k, v in sorted(additional.items())
        ]

    if include_group and group_resource_name:
        person["contactGroupMemberships"] = [
            {"contactGroupResourceName": group_resource_name}
        ]

    return person


def is_empty_customer(cust: dict) -> bool:
    base = base_fields(cust)
    return not (base["first_name"] or base["email"] or base["phone"])
