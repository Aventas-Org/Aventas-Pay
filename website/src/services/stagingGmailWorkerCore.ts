/**
 * Aventas Pay: private, single-replica Railway staging Gmail REVIEW worker.
 *
 * Run: bun run src/bin/staging-gmail-review-worker.ts  (from website/)
 * Mode defaults to DISABLED. Synthetic mode uses no network or real mailbox.
 * OAuth mode reads Gmail with gmail.readonly and looks up ONLY synthetic
 * staging checkout snapshots using a read-only Cloudflare D1 credential.
 *
 * No PAID transition, UPI funds, customer messages, secrets in logs, QR
 * issuance, or fulfillment. This process has no HTTP listener or public port.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlExecutor, SqlValue } from "../adapters/sqlPort";
import { stagingReadOnlyGmailReviewTick } from "./stagingGmailOAuthReview";
import type { ReviewOrderSnapshot } from "./payment/amountOnlyReview";

const STAGING_ACCOUNT = "94080c35924ea4c1cd8b2fba49ddea15";
const STAGING_DB = "9e298657-2d0f-4dcc-818d-9435386c3050";
const FIXED_D1_URL =
  `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}/d1/database/${STAGING_DB}/query`;
export const POLL_MS = 10_000;
const DB_PATH = "/data/aventas-gmail-review.sqlite3";
const SYNTHETIC_FROM = "alerts@example.test";
const SYNTHETIC_TOKEN = "fake-staging-token-no-google-traffic";
const SYNTHETIC_ORDER = "AVT-GMAIL-QA-NOPAY";
const CREDIT = 48024;
const EXPECTED_SOURCE = "staging_synthetic_upi";

type Fetcher = typeof fetch;
type Env = Readonly<Record<string, string | undefined>>;
export type WorkerMode = "disabled" | "synthetic" | "oauth";

function eligible(env: Env): boolean {
  return env.APP_ENV === "staging" && env.RAILWAY_ENVIRONMENT_NAME === "staging";
}

export function chooseMode(env: Env): WorkerMode {
  if (!eligible(env)) return "disabled";
  if (env.GMAIL_REVIEW_MODE === "synthetic") return "synthetic";
  if (env.GMAIL_REVIEW_MODE === "oauth" &&
      env.GMAIL_REVIEW_ENABLED === "true" &&
      env.RAILWAY_VOLUME_MOUNT_PATH === "/data" &&
      typeof env.GMAIL_OAUTH_CLIENT_ID === "string" &&
      typeof env.GMAIL_OAUTH_CLIENT_SECRET === "string" &&
      typeof env.GMAIL_OAUTH_REFRESH_TOKEN === "string" &&
      typeof env.GMAIL_CREDIT_ALERT_SENDER === "string" &&
      typeof env.GMAIL_MAILBOX_CONNECTION_ID === "string" &&
      typeof env.CLOUDFLARE_D1_READ_TOKEN === "string") return "oauth";
  return "disabled";
}

const validAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const validMs = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const safeOrder = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(x);

export async function loadSyntheticStagingOrders(
  token: string,
  nowMs: number,
  fetcher: Fetcher = fetch,
): Promise<readonly ReviewOrderSnapshot[]> {
  if (!token || token.length < 15 || token.length > 4096 || !validMs(nowMs)) {
    throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
  }
  const sql = `SELECT s.order_id AS orderId, s.amount_paise AS amountPaise,
            s.currency AS currency, s.status AS status,
            s.created_at AS paymentWindowStartMs,
            s.expires_at AS paymentWindowEndMs,
            s.source AS source
    FROM checkout_sessions AS s
    JOIN staging_upi_quote_checkout_links AS l ON l.session_id = s.id
    WHERE s.source = '${EXPECTED_SOURCE}'
      AND s.created_at >= ${nowMs - 2 * 24 * 60 * 60 * 1000}
      AND s.created_at <= ${nowMs}
    ORDER BY s.created_at DESC LIMIT 1000`;
  let response: Response;
  try {
    response = await fetcher(FIXED_D1_URL, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql }),
    });
  } catch {
    throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error("STAGING_SNAPSHOT_UNAVAILABLE"); }
  const outer = data as { success?: unknown; result?: unknown };
  if (!outer || outer.success !== true || !Array.isArray(outer.result) ||
      outer.result.length !== 1) throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
  const result = outer.result[0] as { results?: unknown };
  if (!result || !Array.isArray(result.results) || result.results.length > 1000) {
    throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
  }
  const orders: ReviewOrderSnapshot[] = [];
  for (const row of result.results) {
    if (!row || typeof row !== "object") throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
    const r = row as Record<string,unknown>;
    if (!safeOrder(r.orderId) || !validAmount(r.amountPaise) || r.currency !== "INR" ||
        r.source !== EXPECTED_SOURCE || !validMs(r.paymentWindowStartMs) ||
        !validMs(r.paymentWindowEndMs) ||
        r.paymentWindowEndMs <= r.paymentWindowStartMs ||
        !["PENDING","EXPIRED","CANCELLED"].includes(String(r.status))) {
      throw new Error("STAGING_SNAPSHOT_UNAVAILABLE");
    }
    orders.push({
      orderId: r.orderId,
      amountPaise: r.amountPaise,
      currency: "INR",
      status: r.status === "PENDING" && nowMs >= r.paymentWindowEndMs
        ? "EXPIRED"
        : r.status as "PENDING" | "EXPIRED" | "CANCELLED",
      paymentWindowStartMs: r.paymentWindowStartMs,
      paymentWindowEndMs: r.paymentWindowEndMs,
    });
  }
  return orders;
}

/** Pure fake-Google transport for synthetic Railway smoke tests. */
export function syntheticGoogleTransport(createdAtMs: number): Fetcher {
  const body = "You have received ₹480.24 via UPI in your slice bank account TEST0000. Avl. Bal. ₹9,000.00";
  const response = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token" && init?.method === "POST") {
      return response({
        access_token: SYNTHETIC_TOKEN, token_type: "Bearer", expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
    }
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    if (url.startsWith(base + "?")) return response({
      messages: [{ id: "test-gmail-qa-static-0001" }],
    });
    if (url === base + "/test-gmail-qa-static-0001?format=full") {
      return response({
        id: "test-gmail-qa-static-0001",
        internalDate: String(createdAtMs + 1000),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Sandbox <alerts@example.test>" },
            { name: "Subject", value: "Received ₹480.24 in your slice account" },
          ],
          body: { data: Buffer.from(body, "utf8").toString("base64url") },
        },
      });
    }
    return new Response("Blocked synthetic request", { status: 404 });
  }) as Fetcher;
}

export function openReviewDb(path: string = DB_PATH): {
  database: Database;
  executor: SqlExecutor;
} {
  // Main worker refuses to put mailbox evidence on an ephemeral filesystem.
  if (!path.startsWith("/data/") && !path.startsWith("/tmp/")) {
    throw new Error("INVALID_REVIEW_DB_PATH");
  }
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.run("PRAGMA journal_mode=WAL");
  database.run(readFileSync(new URL("../../migrations/0004_email_review_reservations.sql", import.meta.url), "utf8"));
  const executor: SqlExecutor = {
    run: async (q: string, p: SqlValue[]) => ({
      rowsAffected: Number(database.prepare(q).run(...p).changes),
    }),
    get: async <T>(q: string, p: SqlValue[]) =>
      (database.prepare(q).get(...p) ?? null) as T | null,
    all: async <T>(q: string, p: SqlValue[]) =>
      database.prepare(q).all(...p) as T[],
  };
  return { database, executor };
}

export async function reviewTick(
  executor: SqlExecutor,
  env: Env,
  startedAtMs: number,
  nowMs: number,
  fetcher: Fetcher = fetch,
): Promise<{
  mode: WorkerMode;
  examined: number;
  matched: number;
  queued: number;
  paymentVerified: false;
  canFulfill: false;
}> {
  const mode = chooseMode(env);
  if (mode === "disabled") return {
    mode, examined: 0, matched: 0, queued: 0,
    paymentVerified: false, canFulfill: false,
  };
  if (mode === "synthetic") {
    const order: ReviewOrderSnapshot = {
      orderId: SYNTHETIC_ORDER, amountPaise: CREDIT, status: "PENDING", currency: "INR",
      paymentWindowStartMs: startedAtMs - 20_000,
      paymentWindowEndMs: startedAtMs + 120_000,
    };
    const result = await stagingReadOnlyGmailReviewTick(executor, {
      appEnv: "staging", enabled: "true",
      clientId: "synthetic-client-id-123456789",
      clientSecret: "synthetic-client-secret-123456789",
      refreshToken: "synthetic-refresh-token-123456789",
      mailboxConnectionId: "gmail-synthetic-qa",
      candidateAlertSender: SYNTHETIC_FROM,
      nowMs, lookbackHours: 1, maxMessages: 1,
    }, [order], syntheticGoogleTransport(startedAtMs));
    return {
      mode, examined: result.examined,
      queued: result.newlyStaged, matched: result.possibleOrderMatches,
      paymentVerified: false, canFulfill: false,
    };
  }
  const token = env.CLOUDFLARE_D1_READ_TOKEN!;
  const orders = await loadSyntheticStagingOrders(token, nowMs, fetcher);
  // No authoritative order snapshot = do not access mailbox.
  if (orders.length === 0) return {
    mode, examined: 0, queued: 0, matched: 0,
    paymentVerified: false, canFulfill: false,
  };
  const result = await stagingReadOnlyGmailReviewTick(executor, {
    appEnv: "staging", enabled: "true",
    clientId: env.GMAIL_OAUTH_CLIENT_ID!,
    clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET!,
    refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN!,
    mailboxConnectionId: env.GMAIL_MAILBOX_CONNECTION_ID!,
    candidateAlertSender: env.GMAIL_CREDIT_ALERT_SENDER!,
    nowMs, lookbackHours: 1, maxMessages: 10,
  }, orders, fetcher);
  return {
    mode, examined: result.examined,
    queued: result.newlyStaged, matched: result.possibleOrderMatches,
    paymentVerified: false, canFulfill: false,
  };
}

