import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  screenRazorpayWebhookForReview,
  verifyRazorpayWebhookSignature,
  type RazorpayPendingOrderSnapshot,
  type RazorpayReviewReason,
} from "../src/services/payment/razorpayWebhookReview";

const SECRET = "synthetic-webhook-secret-at-least-32-characters-long";
const ORDER_ID = "order_Test12345678";
const PAYMENT_ID = "pay_Test123456789";
const snapshot: RazorpayPendingOrderSnapshot = {
  razorpayOrderId: ORDER_ID,
  amountPaise: 48024,
  currency: "INR",
  status: "PENDING",
};
const entity = {
  id: PAYMENT_ID,
  order_id: ORDER_ID,
  amount: 48024,
  currency: "INR",
  status: "captured",
  captured: true,
  amount_refunded: 0,
  refund_status: null,
};
function body(
  event: string = "payment.captured",
  payment: Record<string, unknown> = entity,
): Uint8Array {
  return Buffer.from(JSON.stringify({ event, payload: { payment: { entity: payment } } }), "utf8");
}
function signed(raw: Uint8Array, secret = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}
function screen(
  raw = body(),
  signature = signed(raw),
  order = snapshot,
  secret = SECRET,
) {
  return screenRazorpayWebhookForReview(raw, signature, secret, order);
}
function denied(reason: RazorpayReviewReason, r: ReturnType<typeof screen>) {
  expect(r.reason).toBe(reason);
  expect(r.classification).toBe("NEEDS_REVIEW");
  expect(r.paymentVerified).toBe(false);
  expect(r.canFulfill).toBe(false);
  expect(r).not.toHaveProperty("status", "PAID");
}

describe("Razorpay HMAC verification (offline; no payments)", () => {
  test("HMAC authenticates exact raw byte sequence, not reconstructed JSON", () => {
    const raw = Buffer.from('{"event":"payment.captured", "payload": {}}', "utf8");
    expect(verifyRazorpayWebhookSignature(raw, signed(raw), SECRET)).toBe(true);
    expect(verifyRazorpayWebhookSignature(
      Buffer.from('{"event":"payment.captured","payload":{}}', "utf8"), signed(raw), SECRET,
    )).toBe(false);
  });

  test("wrong webhook secret, tampering, missing or malformed signature fail", () => {
    const raw = body();
    expect(verifyRazorpayWebhookSignature(raw, signed(raw), "different-long-signing-secret-1234567890")).toBe(false);
    expect(verifyRazorpayWebhookSignature(raw, "", SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(raw, "z".repeat(64), SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(raw, signed(raw), "weak")).toBe(false);
    expect(verifyRazorpayWebhookSignature(Buffer.alloc(0), signed(raw), SECRET)).toBe(false);
    expect(verifyRazorpayWebhookSignature(Buffer.alloc(262145), signed(raw), SECRET)).toBe(false);
  });
});

describe("authenticated webhook review never marks PAID", () => {
  test("matching HMAC and captured event are only a review candidate", () => {
    const res = screen();
    denied("AUTHENTICATED_CANDIDATE_ONLY", res);
    expect(res.webhookAuthenticated).toBe(true);
    expect(Object.keys(res).sort()).toEqual([
      "canFulfill", "classification", "paymentVerified", "reason", "webhookAuthenticated",
    ]);
  });
  test("forged signature is not authenticated", () => {
    const res = screen(body(), "0".repeat(64));
    denied("INVALID_WEBHOOK_SIGNATURE", res);
    expect(res.webhookAuthenticated).toBe(false);
  });
  test("parse only AFTER valid signature; invalid JSON is inert", () => {
    const invalid = Buffer.from("{ not json", "utf8");
    denied("INVALID_JSON", screen(invalid, signed(invalid)));
    denied("INVALID_WEBHOOK_SIGNATURE", screen(invalid, "0".repeat(64)));
  });
  test.each(["payment.authorized", "payment.failed", "refund.processed", "order.paid"])(
    "does not accept unrelated event %s", (event) => {
      const raw = body(event);
      denied("UNSUPPORTED_EVENT", screen(raw, signed(raw)));
    },
  );
  test("valid HMAC with wrong order, amount or currency cannot identify an order", () => {
    for (const update of [
      { order_id: "order_Different123456" },
      { amount: 48000 },
      { currency: "USD" },
    ]) {
      const raw = body("payment.captured", { ...entity, ...update });
      denied("ORDER_OR_AMOUNT_MISMATCH", screen(raw, signed(raw)));
    }
  });
  test("requires a trusted immutable valid order snapshot", () => {
    denied("INVALID_INPUT", screen(body(), signed(body()), { ...snapshot, amountPaise: 0 }));
    denied("INVALID_INPUT", screen(body(), signed(body()), { ...snapshot, razorpayOrderId: "x" }));
  });
  test.each(["PAID", "EXPIRED", "CANCELLED"] as const)(
    "does not replay into terminal order %s", (status) => {
      denied("NON_PENDING_ORDER", screen(body(), signed(body()), { ...snapshot, status }));
    },
  );
  test("invalid payment IDs, missing fields and non-integer paise fail closed", () => {
    for (const update of [
      { id: "not_a_razorpay_id" },
      { order_id: null },
      { amount: 48024.5 },
      { amount: NaN },
      { captured: "true" },
    ]) {
      const raw = body("payment.captured", { ...entity, ...update });
      denied("INVALID_PAYMENT_ENTITY", screen(raw, signed(raw)));
    }
  });
  test("authorized but not captured, refund and chargeback-like states are not capturable proof", () => {
    for (const update of [
      { status: "authorized", captured: false },
      { status: "captured", captured: false },
      { amount_refunded: 100 },
      { refund_status: "partial" },
      { refund_status: "full" },
    ]) {
      const raw = body("payment.captured", { ...entity, ...update });
      denied("NOT_CAPTURED_OR_REFUNDED", screen(raw, signed(raw)));
    }
  });
  test("no UTR, amount-only mail, or customer-controlled callback can make money verified", () => {
    const r = screen();
    expect(r.paymentVerified).toBe(false);
    expect(r.canFulfill).toBe(false);
  });
});
