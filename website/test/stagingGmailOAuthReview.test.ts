import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDatabase, BunSqliteExecutor } from "./helpers/bunSqlite";
import { stagingReadOnlyGmailReviewTick } from "../src/services/stagingGmailOAuthReview";
import type { StagingGmailOAuthConfig } from "../src/services/stagingGmailOAuthReview";
import type { ReviewOrderSnapshot } from "../src/services/payment/amountOnlyReview";

const now = Date.parse("2026-11-07T07:30:10Z");
const config: StagingGmailOAuthConfig = {
  appEnv: "staging", enabled: "true",
  clientId: "synthetic-client-id-123456",
  clientSecret: "synthetic-secret-123456",
  refreshToken: "synthetic-refresh-123456",
  mailboxConnectionId: "synthetic-slice-inbox",
  candidateAlertSender: "alerts@example.test",
  nowMs: now, maxMessages: 5, lookbackHours: 1,
};
const order: ReviewOrderSnapshot = {
  orderId: "AVT-SYNTHETIC-2401", amountPaise: 162624,
  currency: "INR", status: "PENDING",
  paymentWindowStartMs: now - 20_000,
  paymentWindowEndMs: now + 100_000,
};
const encode = (text: string) => Buffer.from(text).toString("base64url");
function fixture() {
  const db = openDatabase();
  db.run(readFileSync(join(import.meta.dir, "..", "migrations",
    "0004_email_review_reservations.sql"), "utf8"));
  return { db, sql: new BunSqliteExecutor(db) };
}

type OAuthResult = { scope?: string; token_type?: string; access_token?: string; expires_in?: number };
function mock(overrides: {
  oauth?: OAuthResult;
  failOAuth?: number;
  subject?: string;
  body?: string;
  received?: string;
} = {}) {
  const calls: { url: string; method: string; authorization: string | null; body?: string }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const uri = String(url);
    const headers = new Headers(init?.headers);
    const isOAuth = uri === "https://oauth2.googleapis.com/token";
    const method = init?.method ?? "GET";
    calls.push({ url: uri, method, authorization: headers.get("authorization"),
      ...(isOAuth ? { body: String(init?.body) } : {}) });
    if (isOAuth) {
      return new Response(JSON.stringify(overrides.oauth ?? {
        access_token: "synthetic-access-token-123456",
        token_type: "Bearer", expires_in: 3599,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }), { status: overrides.failOAuth ?? 200 });
    }
    if (!uri.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
      return new Response("wrong endpoint", { status: 404 });
    }
    if (!uri.includes("?format=full")) {
      return new Response(JSON.stringify({ messages: [{ id: "synthetic-gmail-message-0001" }] }));
    }
    return new Response(JSON.stringify({
      id: "synthetic-gmail-message-0001",
      internalDate: overrides.received ?? String(now - 2000),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Credit alerts <alerts@example.test>" },
          { name: "Subject", value: overrides.subject ?? "Received ₹1,626.24 in your slice account" },
        ],
        body: { data: encode(overrides.body ??
          "You have received ₹1,626.24 via UPI in your slice bank account xx0000. Avl. Bal. ₹100.00") },
      },
    }));
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

describe("staging Gmail readonly OAuth single-tick pipeline", () => {
  test("refreshes token server side and queues only a possible order; repeat is deduplicated", async () => {
    const { db, sql } = fixture();
    const api = mock();
    const a = await stagingReadOnlyGmailReviewTick(sql, config, [order], api.fetcher);
    expect(a).toEqual({
      examined: 1, newlyStaged: 1, repeatedOrConflicting: 0,
      possibleOrderMatches: 1, paymentVerified: false, canFulfill: false,
    });
    const b = await stagingReadOnlyGmailReviewTick(sql, config, [order], api.fetcher);
    expect(b).toMatchObject({
      examined: 1, newlyStaged: 0, repeatedOrConflicting: 1,
      paymentVerified: false, canFulfill: false,
    });
    expect(api.calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(api.calls[0]?.method).toBe("POST");
    expect(api.calls[0]?.authorization).toBeNull();
    expect(api.calls[0]?.body).toContain("grant_type=refresh_token");
    expect(api.calls[1]?.authorization).toBe("Bearer synthetic-access-token-123456");
    const stored = db.query("SELECT * FROM payment_email_review_receipts").all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("synthetic-refresh");
    expect(JSON.stringify(stored)).not.toContain("xx0000");
    expect(JSON.stringify(stored)).not.toContain("synthetic-access-token");
    db.close();
  });

  test("never contacts Google outside explicit staging enabled mode", async () => {
    const { db, sql } = fixture();
    const api = mock();
    for (const changed of [
      { appEnv: "production" }, { appEnv: "" }, { enabled: "false" },
      { refreshToken: "" }, { mailboxConnectionId: "" },
      { candidateAlertSender: "not-an-email" },
      { maxMessages: 100 }, { lookbackHours: 500 },
    ]) {
      await expect(stagingReadOnlyGmailReviewTick(sql, { ...config, ...changed }, [order], api.fetcher))
        .rejects.toThrow("STAGING_GMAIL_REVIEW_DISABLED");
    }
    expect(api.calls).toHaveLength(0);
    db.close();
  });

  test("refuses privileged Gmail scopes or malformed token response", async () => {
    const { db, sql } = fixture();
    for (const oauth of [
      { access_token: "synthetic-access-token-123456", token_type: "Bearer",
        expires_in: 3600, scope: "https://mail.google.com/" },
      { access_token: "synthetic-access-token-123456", token_type: "Bearer",
        expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify" },
      { access_token: "synthetic-access-token-123456", token_type: "bearer",
        expires_in: 3600 },
      { access_token: "too-short", token_type: "Bearer", expires_in: 3600 },
    ]) {
      await expect(stagingReadOnlyGmailReviewTick(sql, config, [order], mock({ oauth }).fetcher))
        .rejects.toThrow("STAGING_GMAIL_OAUTH_INVALID_RESPONSE");
    }
    db.close();
  });

  test("OAuth HTTP failures don't leak response secrets or contact Gmail", async () => {
    const { db, sql } = fixture();
    const api = mock({ failOAuth: 401 });
    await expect(stagingReadOnlyGmailReviewTick(sql, config, [order], api.fetcher))
      .rejects.toThrow("STAGING_GMAIL_OAUTH_UNAVAILABLE");
    expect(api.calls).toHaveLength(1);
    db.close();
  });

  test("a forged debit or conflicting Slice amount cannot produce matching evidence", async () => {
    const { db, sql } = fixture();
    const debit = mock({ subject: "₹1,626.24 debited from your slice account",
      body: "₹1,626.24 debited" });
    const a = await stagingReadOnlyGmailReviewTick(sql, config, [order], debit.fetcher);
    expect(a.possibleOrderMatches).toBe(0);
    // Use a fresh DB for the second email: same message ID would be replay
    // conflict rather than a new unique credit.
    db.close();
    const next = fixture();
    const mismatch = mock({ subject: "Received ₹1,626.24 in your slice account",
      body: "You have received ₹1,626.25 via UPI in your slice bank account xx0000. Avl. Bal. ₹200" });
    const b = await stagingReadOnlyGmailReviewTick(next.sql, config, [order], mismatch.fetcher);
    expect(b.possibleOrderMatches).toBe(0);
    expect(b.canFulfill).toBe(false);
    next.db.close();
  });
});
