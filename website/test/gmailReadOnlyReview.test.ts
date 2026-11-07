import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, BunSqliteExecutor } from "./helpers/bunSqlite";
import {
  fetchGmailReviewEvidence,
  syncGmailEvidenceToReviewQueue,
  type GmailReadOnlyConfig,
} from "../src/services/gmailReadOnlyReview";
import type { ReviewOrderSnapshot } from "../src/services/payment/amountOnlyReview";

const config: GmailReadOnlyConfig = {
  accessToken: "sandbox-temporary-read-only-access-token",
  mailboxConnectionId: "gmail-staging-1",
  candidateAlertSender: "alerts@example.test",
  nowMs: Date.parse("2026-11-07T06:30:00Z"),
  lookbackHours: 36,
  maxMessages: 10,
};
const messageId = "19bcaa122333";
const encode = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const message = {
  id: messageId,
  internalDate: String(Date.parse("2026-11-07T06:29:42.000Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Payment Alerts <alerts@example.test>" },
      { name: "Subject", value: "Received ₹480.24" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: encode("Received INR 480.24. RRN: 123456789012.") } },
      { mimeType: "text/html", body: { data: encode("<b>INR 480.24</b>") } },
    ],
  },
};
const order: ReviewOrderSnapshot = {
  orderId: "AVT-1001", amountPaise: 48024, currency: "INR", status: "PENDING",
  paymentWindowStartMs: Date.parse("2026-11-07T06:25:00.000Z"),
  paymentWindowEndMs: Date.parse("2026-11-07T06:30:00.000Z"),
};
type FakeState = {
  listing?: Record<string, unknown>;
  full?: Record<string, unknown>;
  failStatus?: number;
};
function api(state: FakeState = {}) {
  const calls: { url: string; token: string | null; method: string | undefined }[] = [];
  const adapter = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const header = new Headers(init?.headers);
    calls.push({ url, token: header.get("authorization"), method: init?.method });
    if (state.failStatus) return new Response("bad auth", { status: state.failStatus });
    if (!url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
      return new Response("wrong destination", { status: 404 });
    }
    const isGet = url.includes(`/${messageId}?format=full`);
    const payload = isGet ? (state.full ?? message) :
      (state.listing ?? { messages: [{ id: messageId }, { id: messageId }] });
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { adapter, calls };
}
function setupStore() {
  const db = openDatabase();
  db.run(readFileSync(join(import.meta.dir, "..", "migrations", "0004_email_review_reservations.sql"), "utf8"));
  return { db, store: new BunSqliteExecutor(db) };
}

describe("Gmail OAuth read-only evidence", () => {
  test("uses HTTPS, scoped search, token header and Gmail provider message ID", async () => {
    const { adapter, calls } = api();
    const list = await fetchGmailReviewEvidence(config, adapter);
    expect(list).toHaveLength(1);
    expect(list[0]?.mailboxMessageId).toBe(messageId);
    expect(list[0]?.gmailReceivedAtMs).toBe(Date.parse("2026-11-07T06:29:42.000Z"));
    expect(list[0]?.email.subject).toBe("Received ₹480.24");
    expect(list[0]?.email.body).toContain("INR 480.24");
    expect(list[0]?.email.body).not.toContain("<b>");
    expect(list[0]).not.toHaveProperty("email.authenticationResults");
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.token === `Bearer ${config.accessToken}`)).toBe(true);
    expect(calls.every(c => c.method === "GET")).toBe(true);
    expect(calls[0]!.url).toContain("after%3A");
    expect(calls[0]!.url).toContain("from%3Aalerts%40example.test");
    expect(calls[0]!.url).toContain("includeSpamTrash=false");
  });

  test("keeps all message evidence and bank identifiers out of sync summary", async () => {
    const { db, store } = setupStore();
    const { adapter } = api();
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    expect(sync).toEqual({
      examined: 1, newlyStaged: 1, repeatedOrConflicting: 0,
      possibleOrderMatches: 1, paymentVerified: false, canFulfill: false,
    });
    expect(JSON.stringify(sync)).not.toContain("RRN");
    expect(JSON.stringify(sync)).not.toContain(config.accessToken);
    const persisted = db.query("SELECT * FROM payment_email_review_receipts").all();
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("123456789012");
    db.close();
  });

  test("second scheduled poll de-duplicates the existing email", async () => {
    const { db, store } = setupStore();
    const { adapter } = api();
    await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    expect(await syncGmailEvidenceToReviewQueue(store, config, [order], adapter)).toEqual({
      examined: 1, newlyStaged: 0, repeatedOrConflicting: 1,
      possibleOrderMatches: 0, paymentVerified: false, canFulfill: false,
    });
    expect(db.query("SELECT COUNT(*) AS n FROM payment_email_review_receipts").get()).toEqual({ n: 1 });
    db.close();
  });

  test("untrusted email with same paise can never trigger fulfillment", async () => {
    const { db, store } = setupStore();
    const { adapter } = api({ full: {
      ...message, payload: {
        ...message.payload,
        headers: [
          { name: "From", value: "attacker@example.test" },
          { name: "Subject", value: "Received ₹480.24" },
        ],
      },
    } });
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    expect(sync.possibleOrderMatches).toBe(1);
    expect(sync.paymentVerified).toBe(false);
    expect(sync.canFulfill).toBe(false);
    db.close();
  });

  test("missing list messages is empty, not a made-up paid event", async () => {
    const { adapter } = api({ listing: {} });
    expect(await fetchGmailReviewEvidence(config, adapter)).toEqual([]);
  });

  test("bad sender query, overwide interval and invalid token fail before requests", async () => {
    for (const invalid of [
      { ...config, candidateAlertSender: "alerts@example.test from:attacker.test" },
      { ...config, accessToken: "" },
      { ...config, lookbackHours: 365 },
      { ...config, maxMessages: 500 },
    ]) {
      const { adapter, calls } = api();
      await expect(fetchGmailReviewEvidence(invalid, adapter)).rejects.toThrow("INVALID_GMAIL_REVIEW_CONFIG");
      expect(calls).toHaveLength(0);
    }
  });

  test("HTTP 401/403 never authenticates an email; failure is generic", async () => {
    for (const status of [401, 403]) {
      const { adapter } = api({ failStatus: status });
      await expect(fetchGmailReviewEvidence(config, adapter)).rejects.toThrow("GMAIL_REVIEW_UNAVAILABLE");
    }
  });

  test("malformed or overlong message IDs do not reach get-message endpoint", async () => {
    const { adapter, calls } = api({
      listing: { messages: [{ id: "../../bad" }, { id: "a".repeat(260) }] },
    });
    expect(await fetchGmailReviewEvidence(config, adapter)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("oversized, malformed, or missing MIME body is ignored", async () => {
    for (const data of ["!", encode("a".repeat(16_385)), ""]) {
      const { adapter } = api({ full: {
        ...message,
        payload: { ...message.payload, parts: [
          { mimeType: "text/plain", body: { data } },
        ] },
      } });
      expect(await fetchGmailReviewEvidence(config, adapter)).toEqual([]);
    }
  });

  test("duplicate ids in list are fetched once", async () => {
    const { adapter, calls } = api({ listing: {
      messages: [{ id: messageId }, { id: messageId }, { id: messageId }],
    } });
    expect(await fetchGmailReviewEvidence(config, adapter)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("Gmail internalDate strict timestamp reconciliation", () => {
  test("missing Gmail internalDate gets a review receipt, but no order candidate", async () => {
    const { db, store } = setupStore();
    const { adapter } = api({ full: { ...message, internalDate: undefined } });
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    expect(sync.newlyStaged).toBe(1);
    expect(sync.possibleOrderMatches).toBe(0);
    expect(sync.paymentVerified).toBe(false);
    expect(db.query("SELECT match_reason FROM payment_email_review_receipts").get())
      .toEqual({ match_reason: "TIME_DATA_MISSING" });
    db.close();
  });

  test("malformed or numeric internalDate never falls back to editable Date header", async () => {
    for (const internalDate of ["saturday", "000", 1794032982000, "999999999999999"]) {
      const { db, store } = setupStore();
      const { adapter } = api({ full: { ...message, internalDate, payload: {
        ...message.payload,
        headers: [...message.payload.headers, { name: "Date", value: "Sat, 7 Nov 2026 06:29:42 +0000" }],
      } } });
      const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
      expect(sync.possibleOrderMatches).toBe(0);
      expect(db.query("SELECT match_reason FROM payment_email_review_receipts").get())
        .toEqual({ match_reason: "TIME_DATA_MISSING" });
      db.close();
    }
  });

  test("old Gmail received timestamp is rejected although amount and claimed email date match", async () => {
    const { db, store } = setupStore();
    const { adapter } = api({ full: { ...message,
      internalDate: String(Date.parse("2026-11-06T06:29:42Z")),
      payload: { ...message.payload, headers: [...message.payload.headers,
        { name: "Date", value: "Sat, 7 Nov 2026 06:29:42 +0000" }] },
    } });
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    expect(sync.possibleOrderMatches).toBe(0);
    expect(db.query("SELECT match_reason FROM payment_email_review_receipts").get())
      .toEqual({ match_reason: "OUTSIDE_PAYMENT_WINDOW" });
    db.close();
  });

  test("missing trusted payment window is rejected despite timely email", async () => {
    const { db, store } = setupStore();
    const { adapter } = api();
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [
      { orderId: order.orderId, currency: "INR", amountPaise: 48024, status: "PENDING" },
    ], adapter);
    expect(sync.possibleOrderMatches).toBe(0);
    expect(db.query("SELECT match_reason FROM payment_email_review_receipts").get())
      .toEqual({ match_reason: "TIME_DATA_MISSING" });
    db.close();
  });

  test("same Gmail API message ID with changed received timestamp remains a conflict", async () => {
    const { db, store } = setupStore();
    const { adapter } = api();
    await syncGmailEvidenceToReviewQueue(store, config, [order], adapter);
    const { adapter: changed } = api({ full: {
      ...message, internalDate: String(Date.parse("2026-11-07T06:29:43Z")),
    } });
    const sync = await syncGmailEvidenceToReviewQueue(store, config, [order], changed);
    expect(sync.possibleOrderMatches).toBe(0);
    expect(sync.repeatedOrConflicting).toBe(1);
    db.close();
  });
});
