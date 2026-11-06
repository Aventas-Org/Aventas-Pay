import { describe, expect, test } from "bun:test";
import { parseUntrustedPaymentEmail } from "../src/services/payment/emailEvidenceParser";
import {
  correlateUntrustedEmailAmount,
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
