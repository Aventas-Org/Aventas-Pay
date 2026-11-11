import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncGmailEvidenceToReviewQueue } from "../src/services/gmailReadOnlyReview";
import { openReviewDb, syntheticGoogleTransport } from "../src/services/stagingGmailWorkerCore";

const NOW = 1_793_900_000_000;
const CONFIG = {
  accessToken: "synthetic-test-token",
  mailboxConnectionId: "synthetic-review",
  candidateAlertSender: "alerts@example.test",
  nowMs: NOW,
  lookbackHours: 1,
  maxMessages: 1,
  durableBacklog: true,
};
const ORDER = {
  orderId: "SYNTHETIC-REVIEW",
  amountPaise: 48024,
  currency: "INR",
  status: "PENDING",
  paymentWindowStartMs: NOW - 120_000,
  paymentWindowEndMs: NOW,
} as const;

/** Synthetic Gmail fixture with two pages and optional cursor rejection. */
function mail(rejectContinuation = false) {
  const queries: string[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages")) {
      queries.push(url.searchParams.get("q")!);
      if (url.searchParams.has("pageToken")) {
        if (rejectContinuation) return new Response(null, { status: 400 });
        expect(url.searchParams.get("pageToken")).toBe("next");
        return Response.json({ messages: [{ id: "second" }] });
      }
      return Response.json({ messages: [{ id: "first" }], nextPageToken: "next" });
    }
    const id = url.pathname.split("/").at(-1);
    const source = await syntheticGoogleTransport(NOW - 60_000)(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/test-gmail-qa-static-0001?format=full",
    );
    return Response.json({ ...(await source.json() as object), id });
  }, { preconnect: fetch.preconnect });
  return { fetcher, queries };
}

test("resumes a fixed Gmail listing across a restart and deduplicates a crash replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-backlog-"));
  const path = join(dir, "review.sqlite3");
  const transport = mail();
  let db = openReviewDb(path);
  try {
    let failed = false;
    const interrupted = {
      ...db.executor,
      async run(sql: string, params: (string | number | null)[]) {
        if (!failed && sql.includes("AND page_token IS ?")) {
          failed = true;
          throw new Error("simulated shutdown");
        }
        return db.executor.run(sql, params);
      },
    };
    await expect(syncGmailEvidenceToReviewQueue(interrupted, CONFIG, [ORDER], transport.fetcher))
      .rejects.toThrow("simulated shutdown");
    db.database.close();
    db = openReviewDb(path);

    const later = { ...CONFIG, nowMs: NOW + 3_700_000 };
    const first = await syncGmailEvidenceToReviewQueue(db.executor, later, [ORDER], transport.fetcher);
    expect(first.newlyStaged).toBe(0);
    expect(first.repeatedOrConflicting).toBe(1);
    const second = await syncGmailEvidenceToReviewQueue(
      db.executor, later, [{ ...ORDER, status: "EXPIRED" }], transport.fetcher,
    );
    expect(second.newlyStaged).toBe(1);
    expect(second.possibleOrderMatches).toBe(1);
    expect(second.paymentVerified).toBe(false);
    expect(second.canFulfill).toBe(false);
    expect(new Set(transport.queries).size).toBe(1);
    expect(db.database.query("SELECT count(*) AS n FROM payment_email_review_receipts").get())
      .toEqual({ n: 2 });
    expect(db.database.query("SELECT after_sec, before_sec, page_token FROM gmail_review_scan").get())
      .toEqual({ after_sec: NOW / 1000 - 1, before_sec: null, page_token: null });
  } finally {
    db.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid Gmail continuation restarts the original bounded range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-backlog-"));
  const db = openReviewDb(join(dir, "review.sqlite3"));
  try {
    const transport = mail(true);
    await syncGmailEvidenceToReviewQueue(db.executor, CONFIG, [ORDER], transport.fetcher);
    const later = { ...CONFIG, nowMs: NOW + 3_700_000 };
    await expect(syncGmailEvidenceToReviewQueue(db.executor, later, [ORDER], transport.fetcher))
      .rejects.toThrow("GMAIL_REVIEW_CURSOR_REJECTED");
    expect(db.database.query("SELECT before_sec, page_token FROM gmail_review_scan").get())
      .toEqual({ before_sec: NOW / 1000, page_token: null });
    const replay = await syncGmailEvidenceToReviewQueue(db.executor, later, [ORDER], transport.fetcher);
    expect(replay.repeatedOrConflicting).toBe(1);
    expect(new Set(transport.queries).size).toBe(1);
  } finally {
    db.database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed provider identities preserve the scan across restart and recover on retry", async () => {
  for (const malformed of ["listing", "full"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "gmail-invalid-page-"));
    const path = join(dir, "review.sqlite3");
    let db = openReviewDb(path);
    try {
      const source = mail();
      const broken: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (malformed === "listing" && url.pathname.endsWith("/messages")) {
          return Response.json({ messages: [{ id: "../../invalid" }] });
        }
        const response = await source.fetcher(input, init);
        if (malformed === "full" && !url.pathname.endsWith("/messages")) {
          return Response.json({ ...(await response.json() as object), id: "wrong-id" });
        }
        return response;
      }, { preconnect: fetch.preconnect });
      await expect(syncGmailEvidenceToReviewQueue(db.executor, CONFIG, [ORDER], broken))
        .rejects.toThrow("GMAIL_REVIEW_INVALID_RESPONSE");
      expect(db.database.query("SELECT count(*) AS n FROM payment_email_review_receipts").get())
        .toEqual({ n: 0 });
      const checkpoint = db.database.query("SELECT * FROM gmail_review_scan").get();
      db.database.close();
      db = openReviewDb(path);
      expect(db.database.query("SELECT * FROM gmail_review_scan").get()).toEqual(checkpoint);
      const result = await syncGmailEvidenceToReviewQueue(
        db.executor, { ...CONFIG, nowMs: NOW + 3_700_000 }, [ORDER], mail().fetcher,
      );
      expect(result.newlyStaged).toBe(1);
      expect(result.paymentVerified).toBe(false);
      expect(result.canFulfill).toBe(false);
      expect(db.database.query("SELECT before_sec, page_token FROM gmail_review_scan").get())
        .toEqual({ before_sec: NOW / 1000, page_token: "next" });
    } finally {
      db.database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
