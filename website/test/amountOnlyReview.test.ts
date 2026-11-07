import { describe, expect, test } from "bun:test";
import { parseUntrustedPaymentEmail } from "../src/services/payment/emailEvidenceParser";
import {
  correlateUntrustedEmailAmount,
  correlateUntrustedEmailAmountWithReceivedTime,
  suggestUnusedFractionalAmountPaise,
  type ReviewOrderSnapshot,
} from "../src/services/payment/amountOnlyReview";

const alert = (body: string) => parseUntrustedPaymentEmail({
  from: "claimed-bank@example.test",
  subject: "Incoming credit",
  body,
  authenticationResults: "dkim=pass",
});
const order = (id: string, amountPaise: number, status: ReviewOrderSnapshot["status"] = "PENDING"): ReviewOrderSnapshot => ({
  orderId: id, amountPaise, status, currency: "INR",
});

describe("offline fractional-amount suggestion (never a payable quote)", () => {
  test("proposes exact paise values without using floats", () => {
    expect(suggestUnusedFractionalAmountPaise(48000, [])).toBe(48001);
    expect(suggestUnusedFractionalAmountPaise(48000, [48001, 48002])).toBe(48003);
    expect(suggestUnusedFractionalAmountPaise(48000, [48001, 48024])).toBe(48002);
  });
  test("fails closed when all 99 fractional values are reserved", () => {
    expect(suggestUnusedFractionalAmountPaise(48000, Array.from({ length: 99 }, (_, i) => 48001 + i))).toBeNull();
  });
  test.each([0, -100, 48024, 100.5, NaN, Number.MAX_SAFE_INTEGER])(
    "rejects invalid or already-fractional base %s", (amount) => {
      expect(suggestUnusedFractionalAmountPaise(amount, [])).toBeNull();
    },
  );
  test("rejects invalid occupied amounts instead of pretending to reserve", () => {
    expect(suggestUnusedFractionalAmountPaise(48000, [NaN])).toBeNull();
  });
});

describe("email-amount suggestions never authorize payment", () => {
  test("single possible order is explicitly unverified", () => {
    const result = correlateUntrustedEmailAmount(alert("Received ₹480.24"), [order("a", 48024)]);
    expect(result).toEqual({
      classification: "NEEDS_REVIEW",
      paymentVerified: false,
      canFulfill: false,
      match: "SINGLE_POSSIBLE_ORDER",
      candidateOrderId: "a",
    });
  });
  test("different orders with the same amount are ambiguous, even if one is paid", () => {
    const result = correlateUntrustedEmailAmount(alert("INR 480.24"), [
      order("a", 48024), order("b", 48024, "PAID"),
    ]);
    expect(result.match).toBe("MULTIPLE_MATCHES");
    expect(result.candidateOrderId).toBeNull();
  });
  test("expired or already paid order cannot be treated as pending", () => {
    for (const state of ["PAID", "EXPIRED", "CANCELLED"] as const) {
      const result = correlateUntrustedEmailAmount(alert("₹480.24"), [order("a", 48024, state)]);
      expect(result.match).toBe("NON_PENDING_ORDER");
      expect(result.canFulfill).toBe(false);
    }
  });
  test("no matching amount remains unverified", () => {
    const result = correlateUntrustedEmailAmount(alert("Received ₹480.24"), [order("a", 48025)]);
    expect(result.match).toBe("NO_MATCH");
    expect(result.candidateOrderId).toBeNull();
  });
  test("ambiguous or missing email amount cannot match an order", () => {
    for (const evidence of [alert("₹480.24 and ₹480.25"), alert("No amount")]) {
      const result = correlateUntrustedEmailAmount(evidence, [order("a", 48024)]);
      expect(result.match).toBe("UNUSABLE_EMAIL_AMOUNT");
      expect(result.paymentVerified).toBe(false);
    }
  });
  test("sender spoofing or email auth claims never change settlement authority", () => {
    const evidence = parseUntrustedPaymentEmail({
      from: "attacker@example.test", subject: "Received ₹480.24",
      body: "Successfully credited", authenticationResults: "dkim=pass; dmarc=pass",
    });
    const result = correlateUntrustedEmailAmount(evidence, [order("a", 48024)]);
    expect(result.paymentVerified).toBe(false);
    expect(result.canFulfill).toBe(false);
  });
});

describe("amount + Gmail internalDate + trusted order payment window", () => {
  const start = Date.parse("2026-11-07T08:45:00.000Z");
  const end = Date.parse("2026-11-07T09:00:00.000Z");
  const timed = (status: ReviewOrderSnapshot["status"] = "PENDING"): ReviewOrderSnapshot => ({
    ...order("AVT-100", 48024, status),
    paymentWindowStartMs: start,
    paymentWindowEndMs: end,
  });
  const match = (received: number | undefined, orders = [timed()]) =>
    correlateUntrustedEmailAmountWithReceivedTime(alert("Received ₹480.24"), received, orders);

  test("Gmail arrived nine seconds after Pay Now: one tentative match only", () => {
    const r = match(start + 9000);
    expect(r.match).toBe("SINGLE_POSSIBLE_ORDER");
    expect(r.candidateOrderId).toBe("AVT-100");
    expect(r.paymentVerified).toBe(false);
    expect(r.canFulfill).toBe(false);
  });
  test("old credit notification from before QR display cannot match", () => {
    const r = match(start - 1000);
    expect(r.match).toBe("OUTSIDE_PAYMENT_WINDOW");
    expect(r.candidateOrderId).toBeNull();
  });
  test("short delayed email up to two minutes after expiry is a review hint", () => {
    expect(match(end + 120_000).match).toBe("SINGLE_POSSIBLE_ORDER");
    expect(match(end + 120_001).match).toBe("OUTSIDE_PAYMENT_WINDOW");
  });
  test("a different date is rejected, including previous-day payment", () => {
    expect(match(start - 24 * 60 * 60 * 1000).match).toBe("OUTSIDE_PAYMENT_WINDOW");
  });
  test("crossing midnight IST works with UTC epoch timestamps, not naive time strings", () => {
    const midnightStart = Date.parse("2026-11-07T18:28:00.000Z"); // 23:58 IST
    const midnightEnd = Date.parse("2026-11-07T18:40:00.000Z"); // 00:10 IST on Nov 8
    const late = Date.parse("2026-11-07T18:33:15.000Z"); // 00:03:15 IST on Nov 8
    const r = match(late, [{ ...timed(), paymentWindowStartMs: midnightStart, paymentWindowEndMs: midnightEnd }]);
    expect(r.match).toBe("SINGLE_POSSIBLE_ORDER");
  });
  test.each([undefined, NaN, 0, -1, 1.5])("missing/invalid Gmail receive time %s fails closed", (received) => {
    expect(match(received).match).toBe("TIME_DATA_MISSING");
    expect(match(received).candidateOrderId).toBeNull();
  });
  test("missing or invalid trusted server order times cannot silently fall back", () => {
    for (const changed of [
      { paymentWindowStartMs: undefined },
      { paymentWindowEndMs: undefined },
      { paymentWindowEndMs: start - 1 },
      { paymentWindowEndMs: start + 25 * 60 * 60 * 1000 },
    ]) {
      expect(match(start + 1000, [{ ...timed(), ...changed }]).match).toBe("TIME_DATA_MISSING");
    }
  });
  test("matching amount on multiple orders stays ambiguous despite nonoverlapping times", () => {
    const old = { ...timed(), orderId: "AVT-old",
      paymentWindowStartMs: start - 24 * 60 * 60 * 1000,
      paymentWindowEndMs: start - 23 * 60 * 60 * 1000 };
    const r = match(start + 1000, [timed(), old]);
    expect(r.match).toBe("MULTIPLE_MATCHES");
    expect(r.candidateOrderId).toBeNull();
  });
  test("a terminal order never becomes a candidate via matching time", () => {
    expect(match(start + 1000, [timed("PAID")]).match).toBe("NON_PENDING_ORDER");
  });
  test("wrong amount is never rescued by an exact matching date/time", () => {
    const r = match(start + 1000, [{ ...timed(), amountPaise: 48025 }]);
    expect(r.match).toBe("NO_MATCH");
  });
});
