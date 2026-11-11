// Field mapping and content hashing, ported from setmore_sync/model.py.
// Hashes must stay byte-identical to the Python version so state imported
// from the CLI's SQLite database is still recognised as "unchanged".

export const CLIENT_DATA_KEY = "setmoreKey";

export interface SetmoreCustomer {
  key: string;
  first_name?: string | null;
  last_name?: string | null;
  email_id?: string | null;
  cell_phone?: string | null;
  country_code?: string | null;
  address?: string | null;
  additional_fields?: Record<string, unknown> | null;
}

interface FieldValue {
  value?: string;
}

export interface Person {
  resourceName?: string;
  etag?: string;
  metadata?: { sources?: { type?: string }[] };
  names?: { givenName?: string; familyName?: string }[];
  emailAddresses?: (FieldValue & { type?: string })[];
  phoneNumbers?: (FieldValue & { type?: string })[];
  addresses?: { streetAddress?: string; type?: string }[];
  clientData?: { key?: string; value?: string }[];
  userDefined?: { key?: string; value?: string }[];
}

interface BaseFields {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
}

type Json = string | { [key: string]: Json };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Python truthiness and str() for values coming from Setmore's JSON.
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}

// json.dumps(obj, sort_keys=True) with Python's default separators and
// ensure_ascii escaping.
function pyJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function pyJsonDumps(value: Json): string {
  if (typeof value === "string") return pyJsonString(value);
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => `${pyJsonString(k)}: ${pyJsonDumps(value[k])}`).join(", ") +
    "}"
  );
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hashOf(base: BaseFields, additional: Record<string, string>): Promise<string> {
  return sha256Hex(pyJsonDumps({ base: { ...base }, additional }));
}

export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "_");
}

function e164Phone(cust: SetmoreCustomer): string {
  const phone = text(cust.cell_phone).trim();
  if (!phone) return "";
  if (phone.startsWith("+")) return phone;
  const countryCode = text(cust.country_code).trim().replace(/^\++/, "");
  return countryCode ? `+${countryCode}${phone}` : phone;
}

export function baseFields(cust: SetmoreCustomer): BaseFields {
  return {
    first_name: text(cust.first_name).trim(),
    last_name: text(cust.last_name).trim(),
    email: text(cust.email_id).trim().toLowerCase(),
    phone: e164Phone(cust),
    address: text(cust.address).trim(),
  };
}

export function additionalFields(cust: SetmoreCustomer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cust.additional_fields ?? {})) {
    if (!pyStr(pyTruthy(v) ? v : "").trim()) continue;
    out[sanitizeKey(k)] = pyStr(v);
  }
  return out;
}

export function setmoreHash(cust: SetmoreCustomer): Promise<string> {
  return hashOf(baseFields(cust), additionalFields(cust));
}

function firstOf<T>(items: T[] | undefined): Partial<T> {
  return items && items.length ? items[0] : {};
}

export function googleHash(person: Person): Promise<string> {
  const name = firstOf(person.names);
  const additional: Record<string, string> = {};
  for (const ud of person.userDefined ?? []) {
    if (ud.key && text(ud.value).trim()) additional[ud.key] = text(ud.value);
  }
  return hashOf(
    {
      first_name: text(name.givenName).trim(),
      last_name: text(name.familyName).trim(),
      email: text(firstOf(person.emailAddresses).value).trim().toLowerCase(),
      phone: text(firstOf(person.phoneNumbers).value).trim(),
      address: text(firstOf(person.addresses).streetAddress).trim(),
    },
    additional,
  );
}

export function emailsOf(person: Person): Set<string> {
  return new Set((person.emailAddresses ?? []).map((e) => text(e.value).trim().toLowerCase()));
}

export function isContactSource(person: Person): boolean {
  return (person.metadata?.sources ?? []).some((s) => s.type === "CONTACT");
}

export function clientDataKey(person: Person): string | null {
  const entry = (person.clientData ?? []).find((e) => e.key === CLIENT_DATA_KEY && e.value);
  return entry?.value ?? null;
}

export function displayName(cust: SetmoreCustomer): string {
  const base = baseFields(cust);
  return `${base.first_name} ${base.last_name}`.trim() || "(no name)";
}

export function buildPerson(cust: SetmoreCustomer): Person {
  const base = baseFields(cust);
  const person: Person = {};

  if (base.first_name) {
    person.names = [
      base.last_name
        ? { givenName: base.first_name, familyName: base.last_name }
        : { givenName: base.first_name },
    ];
  }
  if (base.email) person.emailAddresses = [{ value: base.email, type: "other" }];
  if (base.phone) person.phoneNumbers = [{ value: base.phone, type: "mobile" }];
  if (base.address) person.addresses = [{ streetAddress: base.address, type: "home" }];

  person.clientData = [{ key: CLIENT_DATA_KEY, value: cust.key }];

  const additional = additionalFields(cust);
  const keys = Object.keys(additional).sort();
  if (keys.length) person.userDefined = keys.map((k) => ({ key: k, value: additional[k] }));

  return person;
}

export function isEmptyCustomer(cust: SetmoreCustomer): boolean {
  const base = baseFields(cust);
  return !(base.first_name || base.email || base.phone);
}
