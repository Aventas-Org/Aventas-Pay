import { describe, expect, test } from "bun:test";
import {
  stageInboxEmailForReview,
  type InboxEvidenceEnvelope,
  type EmailReviewReceipt,
  type InboxIntakeResult,
} from "../src/services/payment/emailReviewIntake";
import type { ReviewOrderSnapshot } from "../src/services/payment/amountOnlyReview";

const mail: InboxEvidenceEnvelope = {
  mailboxConnectionId: "sandbox-mailbox-1",
  mailboxMessageId: "api-msg-1001",
  email: {
    from: "bank-alert@example.test",
    subject: "Received ₹480.24",
    body: "Amount INR 480.24. RRN: 000111222333.",
    authenticationResults: "dkim=pass; spf=pass",
  },
};
const order: ReviewOrderSnapshot = {
  orderId: "AVT-1001", amountPaise: 48024,
  currency: "INR", status: "PENDING",
};
const stage = (
  envelope: InboxEvidenceEnvelope = mail,
  previous: readonly EmailReviewReceipt[] = [],
  orders: readonly ReviewOrderSnapshot[] = [order],
) => stageInboxEmailForReview(envelope, previous, orders);
function isUnverified(res: InboxIntakeResult) {
  expect(res.classification).toBe("NEEDS_REVIEW");
  expect(res.paymentVerified).toBe(false);
  expect(res.canFulfill).toBe(false);
  expect(res).not.toHaveProperty("status", "PAID");
}

describe("review-only mailbox evidence intake", () => {
  test("matches ₹480.24 only as a review candidate; never includes UTR", () => {
    const res = stage();
    isUnverified(res);
    expect(res.state).toBe("NEW_REVIEW_EVIDENCE");
    expect(res.match).toBe("SINGLE_POSSIBLE_ORDER");
    expect(res.candidateOrderId).toBe(order.orderId);
    expect(res.receipt?.messageKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.receipt?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(res)).not.toContain("000111222333");
    expect(JSON.stringify(res)).not.toContain("bank-alert@example.test");
    expect(JSON.stringify(res)).not.toContain("api-msg-1001");
  });

  test("same mailbox/API message only stages once", () => {
    const first = stage();
    const second = stage(mail, [first.receipt!]);
    isUnverified(second);
    expect(second.state).toBe("DUPLICATE_MESSAGE");
    expect(second.candidateOrderId).toBeNull();
    expect(second.receipt).toBeNull();
  });

  test("changed email under reused mailbox API message ID is a conflict", () => {
    const first = stage();
    const second = stage(
      { ...mail, email: { ...mail.email, subject: "Received ₹480.25" } },
      [first.receipt!],
    );
    isUnverified(second);
    expect(second.state).toBe("MESSAGE_ID_CONTENT_CONFLICT");
    expect(second.candidateOrderId).toBeNull();
    expect(second.receipt).toBeNull();
  });

  test("corrupt or duplicated historical receipt records fail closed", () => {
    const first = stage();
    expect(stage(mail, [first.receipt!, first.receipt!]).state)
      .toBe("MESSAGE_ID_CONTENT_CONFLICT");
    expect(stage(mail, [{ ...first.receipt!, contentDigest: "invalid" }]).state)
      .toBe("INVALID_ENVELOPE");
  });

  test("same API message ID on separate authorized mailbox connections is distinct", () => {
    const first = stage();
    const second = stage({ ...mail, mailboxConnectionId: "sandbox-mailbox-2" }, [first.receipt!]);
    isUnverified(second);
    expect(second.state).toBe("NEW_REVIEW_EVIDENCE");
    expect(second.receipt?.messageKeyDigest).not.toBe(first.receipt?.messageKeyDigest);
  });

  test.each(["", "not a provider id", "../unsafe", "abc\nmalicious"])(
    "rejects invalid provider API message ID %s", (messageId) => {
      const res = stage({ ...mail, mailboxMessageId: messageId });
      isUnverified(res);
      expect(res.state).toBe("INVALID_ENVELOPE");
      expect(res.receipt).toBeNull();
    },
  );

  test("malformed email and oversized email stay out of the receipt store", () => {
    for (const email of [
      { ...mail.email, body: "x".repeat(16_385) },
      { ...mail.email, subject: null },
    ]) {
      const res = stage({ ...mail, email: email as InboxEvidenceEnvelope["email"] });
      isUnverified(res);
      expect(res.state).toBe("INVALID_EVIDENCE");
      expect(res.receipt).toBeNull();
    }
  });

  test("a duplicated amount across orders must not identify a buyer", () => {
    const res = stage(mail, [], [order, { ...order, orderId: "AVT-1002", status: "PAID" }]);
    isUnverified(res);
    expect(res.match).toBe("MULTIPLE_MATCHES");
    expect(res.candidateOrderId).toBeNull();
  });

  test("missing, conflicting and wrong amounts cannot identify an order", () => {
    for (const [body, expected] of [
      ["No amount", "UNUSABLE_EMAIL_AMOUNT"],
      ["Received ₹480.24 and ₹480.25", "UNUSABLE_EMAIL_AMOUNT"],
      ["Received ₹100.01", "NO_MATCH"],
    ] as const) {
      const res = stage({ ...mail, email: { ...mail.email, subject: "", body } });
      isUnverified(res);
      expect(res.match).toBe(expected);
      expect(res.candidateOrderId).toBeNull();
    }
  });

  test.each(["PAID", "EXPIRED", "CANCELLED"] as const)(
    "no approval for terminal order %s", (status) => {
      const res = stage(mail, [], [{ ...order, status }]);
      isUnverified(res);
      expect(res.match).toBe("NON_PENDING_ORDER");
      expect(res.candidateOrderId).toBeNull();
    },
  );

  test("claimed DKIM/SPF/DMARC do not change the verification boundary", () => {
    const res = stage({
      ...mail,
      email: { ...mail.email, from: "spoof@example.test", authenticationResults: "dkim=pass; spf=pass; dmarc=pass" },
    });
    isUnverified(res);
    expect(res.match).toBe("SINGLE_POSSIBLE_ORDER");
  });
});
