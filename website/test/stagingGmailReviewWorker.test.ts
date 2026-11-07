import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseMode, loadSyntheticStagingOrders, openReviewDb, reviewTick,
  syntheticGoogleTransport,
} from "../src/services/stagingGmailWorkerCore";

const startedAtMs = Date.parse("2026-11-07T08:00:00Z");
const stage = {
  APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "staging",
  GMAIL_REVIEW_MODE: "synthetic",
};

describe("Private Railway staging Gmail read-only review runner", () => {
  test("always defaults off and excludes production despite seemingly complete credentials", () => {
    expect(chooseMode({})).toBe("disabled");
    expect(chooseMode({ APP_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging", GMAIL_REVIEW_MODE: "synthetic" }))
      .toBe("disabled");
    expect(chooseMode({ APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "production", GMAIL_REVIEW_MODE: "synthetic" }))
      .toBe("disabled");
    expect(chooseMode({ ...stage, GMAIL_REVIEW_MODE: "oauth" })).toBe("disabled");
    expect(chooseMode(stage)).toBe("synthetic");
  });

  test("synthetic mode gets fake Google credit and durably deduplicates it every 10-second cycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aventas-review-"));
    const { database, executor } = openReviewDb(join(dir, "qa.sqlite3"));
    try {
      const alwaysBlockExternalNetwork = (async () => {
        throw new Error("unexpected real network access");
      }) as typeof fetch;
      const a = await reviewTick(executor, stage, startedAtMs, startedAtMs + 2000,
        alwaysBlockExternalNetwork);
      expect(a).toEqual({
        mode: "synthetic", examined: 1, queued: 1, matched: 1,
        paymentVerified: false, canFulfill: false,
      });
      const repeated = await reviewTick(executor, stage, startedAtMs,
        startedAtMs + 12_000, alwaysBlockExternalNetwork);
      expect(repeated).toEqual({
        mode: "synthetic", examined: 1, queued: 0, matched: 0,
        paymentVerified: false, canFulfill: false,
      });
      const entries = database.prepare("SELECT * FROM payment_email_review_receipts").all();
      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain("TEST0000");
      expect(JSON.stringify(entries)).not.toContain("alerts@example.test");
      expect(JSON.stringify(entries)).not.toContain("fake-staging-token");
      expect((entries[0] as Record<string,unknown>).candidate_order_id).toBe("AVT-GMAIL-QA-NOPAY");
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabled mode has absolutely no network call and no payment verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aventas-review-"));
    const { database, executor } = openReviewDb(join(dir, "qa.sqlite3"));
    try {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        throw new Error("must not be contacted");
      }) as typeof fetch;
      const result = await reviewTick(executor, { ...stage, GMAIL_REVIEW_MODE: "oauth" },
        startedAtMs, startedAtMs + 10000, fetcher);
      expect(result).toMatchObject({
        mode: "disabled", examined: 0, queued: 0, matched: 0,
        paymentVerified: false, canFulfill: false,
      });
      expect(calls).toBe(0);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only exact synthetic checkout sources are accepted from staging D1", async () => {
    const payload = (source: string, amountPaise = 48024) => ({
      success: true, result: [{ results: [{
        orderId: "AVT-TEST-D1", amountPaise,
        currency: "INR", status: "PENDING",
        paymentWindowStartMs: startedAtMs - 20_000,
        paymentWindowEndMs: startedAtMs + 100_000,
        source,
      }] }],
    });
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/d1/database/9e298657-2d0f-4dcc-818d-9435386c3050/query");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-read-d1-token");
      const b = JSON.parse(String(init?.body)) as { sql:string };
      expect(b.sql).toContain("staging_synthetic_upi");
      expect(b.sql).not.toContain("UPDATE");
      return new Response(JSON.stringify(payload("staging_synthetic_upi")), { status: 200 });
    }) as typeof fetch;
    const orders = await loadSyntheticStagingOrders(
      "synthetic-read-d1-token", startedAtMs, fetcher);
    expect(orders).toEqual([{
      orderId: "AVT-TEST-D1", amountPaise: 48024, currency: "INR",
      status: "PENDING", paymentWindowStartMs: startedAtMs - 20_000,
      paymentWindowEndMs: startedAtMs + 100_000,
    }]);
    for (const bad of ["discord_bot", "upi_live", "staging_random"]) {
      await expect(loadSyntheticStagingOrders("synthetic-read-d1-token", startedAtMs,
        (async () => new Response(JSON.stringify(payload(bad)))) as typeof fetch))
        .rejects.toThrow("STAGING_SNAPSHOT_UNAVAILABLE");
    }
    await expect(loadSyntheticStagingOrders("synthetic-read-d1-token", startedAtMs,
      (async () => new Response(JSON.stringify(payload("staging_synthetic_upi", 1.25)))) as typeof fetch))
      .rejects.toThrow("STAGING_SNAPSHOT_UNAVAILABLE");
  });

  test("OAuth mode requires every secret, the 10-second worker remains review-only", async () => {
    const full = {
      ...stage, GMAIL_REVIEW_MODE: "oauth",
      GMAIL_REVIEW_ENABLED: "true",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
      GMAIL_OAUTH_CLIENT_ID: "fake-client-id-12345",
      GMAIL_OAUTH_CLIENT_SECRET: "fake-client-secret-12345",
      GMAIL_OAUTH_REFRESH_TOKEN: "fake-refresh-token-12345",
      GMAIL_CREDIT_ALERT_SENDER: "alerts@example.test",
      GMAIL_MAILBOX_CONNECTION_ID: "gmail-qa-1",
      CLOUDFLARE_D1_READ_TOKEN: "synthetic-read-d1-token",
    };
    expect(chooseMode(full)).toBe("oauth");
    expect(chooseMode({ ...full, GMAIL_OAUTH_REFRESH_TOKEN: undefined })).toBe("disabled");
    expect(chooseMode({ ...full, RAILWAY_VOLUME_MOUNT_PATH: undefined })).toBe("disabled");
    const dir = mkdtempSync(join(tmpdir(), "aventas-review-"));
    const { database, executor } = openReviewDb(join(dir,"qa.sqlite3"));
    try {
      const google = syntheticGoogleTransport(startedAtMs);
      let requests = 0;
      const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests += 1;
        if (String(url).includes("api.cloudflare.com")) {
          return new Response(JSON.stringify({ success: true, result: [{ results: [{
            orderId: "AVT-GMAIL-QA-NOPAY", amountPaise: 48024,
            currency: "INR", status: "PENDING",
            paymentWindowStartMs: startedAtMs - 20_000,
            paymentWindowEndMs: startedAtMs + 120_000,
            source: "staging_synthetic_upi",
          }] }] }), { status: 200 });
        }
        return google(url, init);
      }) as typeof fetch;
      const result = await reviewTick(executor, full, startedAtMs, startedAtMs + 2000, fake);
      expect(result).toMatchObject({
        mode: "oauth", examined: 1, queued: 1, matched: 1,
        paymentVerified: false, canFulfill: false,
      });
      expect(requests).toBeGreaterThanOrEqual(3);
      expect(database.prepare("SELECT count(*) AS n FROM payment_email_review_receipts").get())
        .toEqual({n:1});
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
