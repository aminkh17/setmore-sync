import type { Person } from "./model";

const PEOPLE_API = "https://people.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const READ_MASK = "metadata,names,emailAddresses,phoneNumbers,addresses,clientData,userDefined";
const UPDATE_MASK = "names,emailAddresses,phoneNumbers,addresses,clientData,userDefined";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BATCH_SIZE = 200;

export class GoogleError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunks<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Params = Record<string, string | string[]>;

export class GoogleContacts {
  private accessToken: string | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly retries = 4,
  ) {}

  // ---- auth ----

  private async refreshAccessToken(): Promise<string> {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body = await resp.text();
    if (!resp.ok) {
      const hint = body.includes("invalid_grant")
        ? " The Google refresh token expired or was revoked: run `setmore-sync setup-google --force`, then `npm run push-google-token`."
        : "";
      throw new GoogleError(`Google token refresh failed (HTTP ${resp.status}): ${body.slice(0, 300)}${hint}`);
    }
    return (JSON.parse(body) as { access_token: string }).access_token;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    { params, body }: { params?: Params; body?: unknown } = {},
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      for (const item of Array.isArray(v) ? v : [v]) query.append(k, item);
    }
    const qs = query.toString();
    const url = `${PEOPLE_API}${path}${qs ? `?${qs}` : ""}`;

    let refreshed = false;
    this.accessToken ??= await this.refreshAccessToken();
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (RETRY_STATUSES.has(resp.status)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (resp.status === 401 && !refreshed) {
        this.accessToken = await this.refreshAccessToken();
        refreshed = true;
        continue;
      }
      const text = await resp.text();
      if (!resp.ok) {
        throw new GoogleError(`Google ${path} failed (HTTP ${resp.status}): ${text.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new GoogleError("Google API rate limited after retries");
  }

  // ---- search ----

  /** An empty query refreshes Google's search cache before real searches. */
  async warmupSearch(): Promise<void> {
    try {
      await this.request("GET", "/people:searchContacts", { params: { query: "", readMask: "names" } });
    } catch {
      // Best effort only.
    }
  }

  async searchContacts(query: string): Promise<Person[]> {
    const resp = await this.request<{ results?: { person?: Person }[] }>("GET", "/people:searchContacts", {
      params: { query, readMask: READ_MASK, pageSize: "30" },
    });
    return (resp.results ?? []).flatMap((r) => (r.person ? [r.person] : []));
  }

  // ---- read ----

  /** people:batchGet is a GET with repeated resourceNames query params. */
  async batchGet(resourceNames: string[]): Promise<Person[]> {
    const persons: Person[] = [];
    for (const chunk of chunks(resourceNames)) {
      const resp = await this.request<{ responses?: { person?: Person }[] }>("GET", "/people:batchGet", {
        params: { resourceNames: chunk, personFields: READ_MASK },
      });
      for (const r of resp.responses ?? []) if (r.person) persons.push(r.person);
    }
    return persons;
  }

  // ---- write ----

  /** batchCreateContacts rejects contactGroupMemberships; use addToGroup afterwards. */
  async batchCreate(persons: Person[]): Promise<Person[]> {
    const created: Person[] = [];
    for (const chunk of chunks(persons)) {
      const resp = await this.request<{ createdPeople?: { person?: Person }[] }>(
        "POST",
        "/people:batchCreateContacts",
        { body: { contacts: chunk.map((p) => ({ contactPerson: p })), readMask: READ_MASK } },
      );
      for (const cp of resp.createdPeople ?? []) if (cp.person?.resourceName) created.push(cp.person);
    }
    return created;
  }

  /** contacts maps resource name -> person (including its current etag). */
  async batchUpdate(contacts: Record<string, Person>): Promise<void> {
    for (const chunk of chunks(Object.entries(contacts))) {
      await this.request("POST", "/people:batchUpdateContacts", {
        body: { contacts: Object.fromEntries(chunk), updateMask: UPDATE_MASK, readMask: READ_MASK },
      });
    }
  }

  // ---- groups ----

  async getOrCreateGroup(name: string): Promise<string> {
    let pageToken: string | undefined;
    do {
      const params: Params = { pageSize: "1000" };
      if (pageToken) params.pageToken = pageToken;
      const resp = await this.request<{
        contactGroups?: { name?: string; resourceName: string }[];
        nextPageToken?: string;
      }>("GET", "/contactGroups", { params });
      const match = (resp.contactGroups ?? []).find((g) => g.name === name);
      if (match) return match.resourceName;
      pageToken = resp.nextPageToken;
    } while (pageToken);

    // The create response is a bare ContactGroup, not wrapped in "contactGroup".
    const created = await this.request<{ resourceName: string }>("POST", "/contactGroups", {
      body: { contactGroup: { name } },
    });
    return created.resourceName;
  }

  /** groupResource is the full "contactGroups/<id>" resource name. */
  async addToGroup(groupResource: string, resourceNames: string[]): Promise<void> {
    for (const chunk of chunks(resourceNames)) {
      await this.request("POST", `/${groupResource}/members:modify`, {
        body: { resourceNamesToAdd: chunk },
      });
    }
  }
}
