// Sync orchestration, ported from setmore_sync/sync.py.
import { GoogleContacts } from "./google";
import {
  buildPerson,
  clientDataKey,
  displayName,
  emailsOf,
  googleHash,
  isContactSource,
  isEmptyCustomer,
  setmoreHash,
  type Person,
  type SetmoreCustomer,
} from "./model";
import { SetmoreClient } from "./setmore";
import type { State } from "./state";

export interface SyncConfig {
  setmoreRefreshToken: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  useContactGroup: boolean;
  contactGroupName: string;
  historyStart: string;
  lookbackDays: number;
}

export interface SyncOptions {
  trigger: string;
  dryRun?: boolean;
  fullHistory?: boolean;
}

export interface SyncSummary {
  trigger: string;
  dryRun: boolean;
  fullHistory: boolean;
  fetched: number;
  unchanged: number;
  toUpdate: number;
  linked: number;
  toCreate: number;
  skippedEmpty: number;
  errors: string[];
  durationMs: number;
  /** Customer names per action; returned to HTTP callers, not logged. */
  details: { create: string[]; update: string[]; link: string[] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

function parseDate(ddmmyyyy: string): Date {
  const [dd, mm, yyyy] = ddmmyyyy.split("-").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

/** Per-calendar-year windows from the start date until two years ahead. */
export function dateWindows(
  fullHistory: boolean,
  historyStart: string,
  lookbackDays: number,
  now = new Date(),
): [string, string][] {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = fullHistory ? parseDate(historyStart) : new Date(today.getTime() - lookbackDays * DAY_MS);
  const end = new Date(today.getTime() + 730 * DAY_MS);

  const windows: [string, string][] = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
    const windowStart = new Date(Math.max(start.getTime(), Date.UTC(year, 0, 1)));
    const windowEnd = new Date(Math.min(end.getTime(), Date.UTC(year, 11, 31)));
    if (windowStart > windowEnd) continue;
    windows.push([formatDate(windowStart), formatDate(windowEnd)]);
  }
  return windows;
}

function matchingContact(results: Person[], email: string): Person | undefined {
  return results.find((p) => isContactSource(p) && emailsOf(p).has(email));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runSync(cfg: SyncConfig, state: State, opts: SyncOptions): Promise<SyncSummary> {
  const startedAt = Date.now();
  const dryRun = Boolean(opts.dryRun);
  const fullHistory = Boolean(opts.fullHistory);

  const setmore = new SetmoreClient(cfg.setmoreRefreshToken);
  const customers = new Map<string, SetmoreCustomer>();
  for (const [start, end] of dateWindows(fullHistory, cfg.historyStart, cfg.lookbackDays)) {
    for (const cust of await setmore.fetchCustomers(start, end)) customers.set(cust.key, cust);
  }

  const google = new GoogleContacts(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRefreshToken);
  await google.warmupSearch();
  const groupResource =
    cfg.useContactGroup && !dryRun ? await google.getOrCreateGroup(cfg.contactGroupName) : null;

  const mappings = await state.loadAll();
  const summary: SyncSummary = {
    trigger: opts.trigger,
    dryRun,
    fullHistory,
    fetched: customers.size,
    unchanged: 0,
    toUpdate: 0,
    linked: 0,
    toCreate: 0,
    skippedEmpty: 0,
    errors: [],
    durationMs: 0,
    details: { create: [], update: [], link: [] },
  };

  const creates: { cust: SetmoreCustomer; hash: string }[] = [];
  const updates = new Map<string, SetmoreCustomer>(); // resource name -> customer
  const links: { key: string; resourceName: string; contentHash: string }[] = [];

  for (const cust of customers.values()) {
    if (isEmptyCustomer(cust)) {
      summary.skippedEmpty++;
      continue;
    }
    const hash = await setmoreHash(cust);

    const mapped = mappings.get(cust.key);
    if (mapped) {
      if (mapped.contentHash !== hash) updates.set(mapped.resourceName, cust);
      else summary.unchanged++;
      continue;
    }

    // Not mapped yet: link an existing Google contact by email to avoid duplicates.
    const email = (cust.email_id ?? "").trim().toLowerCase();
    if (email) {
      const existing = matchingContact(await google.searchContacts(email), email);
      if (existing?.resourceName) {
        // Store Google's current hash so a content mismatch shows up as an update.
        const existingHash = await googleHash(existing);
        if (existingHash !== hash) updates.set(existing.resourceName, cust);
        links.push({ key: cust.key, resourceName: existing.resourceName, contentHash: existingHash });
        summary.details.link.push(displayName(cust));
        continue;
      }
    }

    creates.push({ cust, hash });
  }

  summary.toUpdate = updates.size;
  summary.linked = links.length;
  summary.toCreate = creates.length;
  summary.details.create = creates.map((c) => displayName(c.cust));
  summary.details.update = [...updates.values()].map(displayName);

  if (dryRun) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const groupMembers: string[] = [];

  await state.upsertMany(links);
  groupMembers.push(...links.map((l) => l.resourceName));

  if (creates.length) {
    const hashByKey = new Map(creates.map((c) => [c.cust.key, c.hash]));
    const created = await google.batchCreate(creates.map((c) => buildPerson(c.cust)));
    const rows = created.flatMap((person) => {
      const key = clientDataKey(person);
      const hash = key ? hashByKey.get(key) : undefined;
      return key && hash && person.resourceName
        ? [{ key, resourceName: person.resourceName, contentHash: hash }]
        : [];
    });
    // Record created contacts before anything else can fail, so a retry never duplicates them.
    await state.upsertMany(rows);
    groupMembers.push(...rows.map((r) => r.resourceName));
  }

  if (groupResource && groupMembers.length) {
    try {
      await google.addToGroup(groupResource, groupMembers);
    } catch (err) {
      summary.errors.push(`Adding contacts to group failed: ${errorMessage(err)}`);
    }
  }

  if (updates.size) {
    await executeUpdates(google, state, updates, summary);
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

async function executeUpdates(
  google: GoogleContacts,
  state: State,
  updates: Map<string, SetmoreCustomer>,
  summary: SyncSummary,
): Promise<void> {
  const current = new Map(
    (await google.batchGet([...updates.keys()])).map((p) => [p.resourceName ?? "", p]),
  );

  const contacts: Record<string, Person> = {};
  const targets: { resourceName: string; cust: SetmoreCustomer }[] = [];
  for (const [resourceName, cust] of updates) {
    const person = current.get(resourceName);
    if (!person) {
      summary.errors.push(`No Google contact found for ${resourceName}`);
      continue;
    }
    contacts[resourceName] = { ...buildPerson(cust), etag: person.etag };
    targets.push({ resourceName, cust });
  }
  if (!targets.length) return;

  let succeeded = targets;
  try {
    await google.batchUpdate(contacts);
  } catch {
    // Retry one by one so a single bad contact doesn't block the rest.
    succeeded = [];
    for (const target of targets) {
      try {
        await google.batchUpdate({ [target.resourceName]: contacts[target.resourceName] });
        succeeded.push(target);
      } catch (err) {
        summary.errors.push(errorMessage(err));
      }
    }
  }

  const rows = await Promise.all(
    succeeded.map(async (t) => ({
      key: t.cust.key,
      resourceName: t.resourceName,
      contentHash: await setmoreHash(t.cust),
    })),
  );
  await state.upsertMany(rows);
}
