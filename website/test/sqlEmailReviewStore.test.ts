import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, BunSqliteExecutor } from "./helpers/bunSqlite";
import {
  reserveFractionalAmountProposal,
  queueEmailEvidenceForReview,
} from "../src/services/sqlEmailReviewStore";
import type { InboxEvidenceEnvelope } from "../src/services/payment/emailReviewIntake";
import type { ReviewOrderSnapshot } from "../src/services/payment/amountOnlyReview";

const NOW = Date.parse("2026-11-07T05:00:00.000Z");
const envelope: InboxEvidenceEnvelope = {
  mailboxConnectionId: "staging-mailbox",
  mailboxMessageId: "gmail-provider-id-0001",
  email: {
    from: "Bank Alert <alerts@bank.example>",
    subject: "You received ₹480.24",
    body: "Amount INR 480.24 RRN: 123456789012",
  },
};
const candidate: ReviewOrderSnapshot = {
  orderId: "AVT-1000", amountPaise: 48024,
  currency: "INR", status: "PENDING",
};

function setup() {
  const db = openDatabase();
  db.run(readFileSync(join(import.meta.dir, "..", "migrations", "0004_email_review_reservations.sql"), "utf8"));
  return { db, store: new BunSqliteExecutor(db) };
}
const reserve = (orderId: string, recipientKey = "real-recipient-1", baseAmountPaise = 48000) => ({
  recipientKey, orderId, baseAmountPaise, createdAtMs: NOW,
});

describe("database-enforced non-repeating paise proposals", () => {
  test("reserves ₹480.01 and ₹480.02, never the same amount for the same recipient", async () => {
    const { db, store } = setup();
    expect(await reserveFractionalAmountProposal(store, reserve("AVT-a"))).toEqual({
      kind: "RESERVED", amountPaise: 48001,
    });
    expect(await reserveFractionalAmountProposal(store, reserve("AVT-b"))).toEqual({
      kind: "RESERVED", amountPaise: 48002,
    });
    expect(db.query("SELECT COUNT(*) AS n FROM payment_amount_reservations").get()).toEqual({ n: 2 });
    db.close();
  });
  test("idempotent replay retains amount; mutated order facts fail closed", async () => {
    const { db, store } = setup();
    await reserveFractionalAmountProposal(store, reserve("AVT-a"));
    expect(await reserveFractionalAmountProposal(store, reserve("AVT-a"))).toEqual({
      kind: "REPLAY", amountPaise: 48001,
    });
    expect(await reserveFractionalAmountProposal(store, reserve("AVT-a", "real-recipient-1", 48100))).toEqual({
      kind: "ORDER_FACTS_CHANGED", amountPaise: null,
    });
    db.close();
  });
  test("different UPI aliases for one actual account share the same recipient key", async () => {
    const { db, store } = setup();
    const a = await reserveFractionalAmountProposal(store, reserve("AVT-primary", "same-actual-bank-account"));
    const b = await reserveFractionalAmountProposal(store, reserve("AVT-fallback", "same-actual-bank-account"));
    expect(a.amountPaise).toBe(48001);
    expect(b.amountPaise).toBe(48002);
    db.close();
  });
  test("separately approved real recipients can independently use the same amount", async () => {
    const { db, store } = setup();
    const a = await reserveFractionalAmountProposal(store, reserve("AVT-a", "account-a"));
    const b = await reserveFractionalAmountProposal(store, reserve("AVT-b", "account-b"));
    expect(a.amountPaise).toBe(b.amountPaise);
    db.close();
  });
  test("concurrent reservations are arbitrated by SQL uniqueness", async () => {
    const { db, store } = setup();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveFractionalAmountProposal(store, reserve(`AVT-concurrent-${i}`)),
      ),
    );
    const amounts = outcomes.map(x => x.amountPaise);
    expect(amounts.every(x => typeof x === "number")).toBe(true);
    expect(new Set(amounts).size).toBe(20);
    db.close();
  });
  test("fails closed after all 99 nonzero fractions are occupied", async () => {
    const { db, store } = setup();
    for (let i = 0; i < 99; i++) {
      expect((await reserveFractionalAmountProposal(store, reserve(`AVT-${i}`))).kind).toBe("RESERVED");
    }
    expect(await reserveFractionalAmountProposal(store, reserve("AVT-100"))).toEqual({
      kind: "EXHAUSTED", amountPaise: null,
    });
    db.close();
  });
  test.each([0, -100, 48024, 1.01, NaN, Number.MAX_SAFE_INTEGER])(
    "rejects invalid base amount %s", async (value) => {
      const { db, store } = setup();
      const r = await reserveFractionalAmountProposal(store, reserve("AVT-test", "r", value));
      expect(r).toEqual({ kind: "INVALID", amountPaise: null });
      db.close();
    },
  );
  test("rejects invalid ids/timestamps, keeping tables unchanged", async () => {
    const { db, store } = setup();
    expect((await reserveFractionalAmountProposal(store, {
      ...reserve("AVT-x"), orderId: "AVT x",
    })).kind).toBe("INVALID");
    expect((await reserveFractionalAmountProposal(store, {
      ...reserve("AVT-x"), createdAtMs: 0,
    })).kind).toBe("INVALID");
    expect(db.query("SELECT COUNT(*) AS n FROM payment_amount_reservations").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("durable incoming email is review evidence only", () => {
  test("stores one opaque receipt and tentative match, no raw UTR or email", async () => {
    const { db, store } = setup();
    const outcome = await queueEmailEvidenceForReview(store, envelope, [candidate], NOW);
    expect(outcome.kind).toBe("INSERTED");
    expect(outcome.intake.match).toBe("SINGLE_POSSIBLE_ORDER");
    expect(outcome.intake.candidateOrderId).toBe("AVT-1000");
    expect(outcome.intake.paymentVerified).toBe(false);
    expect(outcome.intake.canFulfill).toBe(false);
    const row = db.query("SELECT * FROM payment_email_review_receipts").get() as Record<string, unknown>;
    expect(row.match_reason).toBe("SINGLE_POSSIBLE_ORDER");
    expect(row.candidate_order_id).toBe("AVT-1000");
    expect(JSON.stringify(row)).not.toContain("123456789012");
    expect(JSON.stringify(row)).not.toContain("alerts@bank.example");
    db.close();
  });
  test("same Gmail message ID replay never inserts twice", async () => {
    const { db, store } = setup();
    await queueEmailEvidenceForReview(store, envelope, [candidate], NOW);
    const repeated = await queueEmailEvidenceForReview(store, envelope, [candidate], NOW);
    expect(repeated.kind).toBe("DUPLICATE");
    expect(repeated.intake.candidateOrderId).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM payment_email_review_receipts").get()).toEqual({ n: 1 });
    db.close();
  });
  test("altered content under same Gmail ID is a hold, not a fresh match", async () => {
    const { db, store } = setup();
    await queueEmailEvidenceForReview(store, envelope, [candidate], NOW);
    const changed = await queueEmailEvidenceForReview(store, {
      ...envelope, email: { ...envelope.email, subject: "You received ₹480.25" },
    }, [candidate], NOW);
    expect(changed.kind).toBe("CONTENT_CONFLICT");
    expect(changed.intake.paymentVerified).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM payment_email_review_receipts").get()).toEqual({ n: 1 });
    db.close();
  });
  test("no matching order and duplicate fractional amounts remain NEEDS_REVIEW", async () => {
    const { db, store } = setup();
    const none = await queueEmailEvidenceForReview(store, envelope, [], NOW);
    expect(none.intake.match).toBe("NO_MATCH");
    const ambiguous = await queueEmailEvidenceForReview(store, {
      ...envelope, mailboxMessageId: "gmail-provider-id-0002",
    }, [candidate, { ...candidate, orderId: "AVT-1001" }], NOW);
    expect(ambiguous.intake.match).toBe("MULTIPLE_MATCHES");
    expect(ambiguous.intake.candidateOrderId).toBeNull();
    db.close();
  });
  test("bad time or malformed inbox ID never inserts evidence", async () => {
    const { db, store } = setup();
    const res = await queueEmailEvidenceForReview(store, envelope, [candidate], 0);
    expect(res.kind).toBe("REJECTED");
    expect(res.intake.paymentVerified).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM payment_email_review_receipts").get()).toEqual({ n: 0 });
    db.close();
  });
});
