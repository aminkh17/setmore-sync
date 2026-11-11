import { State } from "./state";
import { runSync, type SyncConfig, type SyncOptions, type SyncSummary } from "./sync";

export interface Env {
  DB: D1Database;
  // Secrets
  SETMORE_REFRESH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  SYNC_TOKEN: string;
  // Vars (wrangler.jsonc)
  USE_CONTACT_GROUP: string;
  CONTACT_GROUP_NAME: string;
  HISTORY_START: string;
  LOOKBACK_DAYS: string;
}

type RunResult = SyncSummary | { status: "queued"; message: string };

const LOCK_TTL_MS = 5 * 60 * 1000;
const REQUIRED_SECRETS = [
  "SETMORE_REFRESH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;

function configFrom(env: Env): SyncConfig {
  const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing Worker secrets: ${missing.join(", ")}`);
  return {
    setmoreRefreshToken: env.SETMORE_REFRESH_TOKEN,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,
    useContactGroup: env.USE_CONTACT_GROUP !== "false",
    contactGroupName: env.CONTACT_GROUP_NAME || "Setmore",
    historyStart: env.HISTORY_START || "01-01-2015",
    lookbackDays: Number(env.LOOKBACK_DAYS) || 7,
  };
}

/**
 * Runs one sync at a time. A trigger that arrives mid-sync queues a single
 * follow-up run, so a booking made during a sync is still picked up.
 */
async function runExclusive(env: Env, opts: SyncOptions): Promise<RunResult> {
  const cfg = configFrom(env);
  const state = new State(env.DB);
  if (opts.dryRun) return runSync(cfg, state, opts);

  const owner = crypto.randomUUID();
  if (!(await state.acquireLock(owner, LOCK_TTL_MS))) {
    await state.requestRerun();
    return { status: "queued", message: "Another sync is running; it will run again when it finishes." };
  }
  try {
    // Anything requested before this sync fetches from Setmore is covered by it.
    await state.takeRerunRequest();
    let summary = await runSync(cfg, state, opts);
    // At most one rerun, to stay well within the per-invocation subrequest limit.
    if (await state.takeRerunRequest()) {
      summary = await runSync(cfg, state, { trigger: `${opts.trigger}+rerun` });
    }
    return summary;
  } finally {
    await state.releaseLock(owner);
  }
}

async function runAndLog(env: Env, opts: SyncOptions): Promise<RunResult> {
  try {
    const result = await runExclusive(env, opts);
    if ("details" in result) {
      const { details: _details, ...counts } = result;
      console.log({ event: "sync", ...counts });
    } else {
      console.log({ event: "sync", trigger: opts.trigger, ...result });
    }
    return result;
  } catch (err) {
    console.error({ event: "sync_failed", trigger: opts.trigger, error: String(err) });
    throw err;
  }
}

function authorized(request: Request, env: Env): boolean {
  if (!env.SYNC_TOKEN) return false;
  const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(env.SYNC_TOKEN);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  // Manual trigger: POST /run with "Authorization: Bearer <SYNC_TOKEN>".
  // Query: ?dry=1 (plan only, no writes), ?full=1 (backfill from HISTORY_START).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });

    try {
      const result = await runAndLog(env, {
        trigger: "http",
        dryRun: url.searchParams.get("dry") === "1",
        fullHistory: url.searchParams.get("full") === "1",
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },

  // Backup schedule (see wrangler.jsonc).
  async scheduled(_controller, env) {
    await runAndLog(env, { trigger: "cron" });
  },

  // Booking notification emails routed here by Cloudflare Email Routing.
  // The message itself is ignored (and dropped); it only triggers a sync.
  async email(message, env) {
    console.log({ event: "email_received", from: message.from, to: message.to });

    // Adding this address as a Gmail forwarding address sends a one-time
    // confirmation; log it so the code/link can be read from the Worker logs.
    if (message.from === "forwarding-noreply@google.com") {
      const raw = await new Response(message.raw).text();
      console.log({
        event: "gmail_forwarding_confirmation",
        subject: message.headers.get("subject"),
        raw: raw.slice(0, 50_000),
      });
      return;
    }

    try {
      await runAndLog(env, { trigger: "email" });
    } catch {
      // Already logged; never bounce the notification back to Setmore.
    }
  },
} satisfies ExportedHandler<Env>;
