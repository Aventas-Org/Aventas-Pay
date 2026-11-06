/**
 * Razorpay webhook HMAC verification and captured-event pre-screen for tests.
 *
 * This is a SIDE-EFFECT-FREE security primitive, not a live webhook endpoint,
 * a provider API query, settlement attestation, payment ledger or order update.
 * Its output NEVER authorizes fulfillment, even when the HMAC is correct.
 *
 * IMPORTANT: webhook signatures authenticate webhook origin only. To enable
 * payments in a separately approved provider integration, fetch the payment
 * from Razorpay with server-side merchant credentials, verify capture/order/
 * amount, persist event + payment uniqueness and reconcile settlements.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const HEX_SHA256 = /^[a-fA-F0-9]{64}$/;
const RAZORPAY_ORDER_ID = /^order_[A-Za-z0-9]{6,64}$/;
const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,64}$/;

export interface RazorpayPendingOrderSnapshot {
  /** Trusted persisted mapping, never taken from the webhook or browser. */
  readonly razorpayOrderId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
}

export type RazorpayReviewReason =
  | "INVALID_INPUT"
  | "INVALID_WEBHOOK_SIGNATURE"
  | "INVALID_JSON"
  | "UNSUPPORTED_EVENT"
  | "INVALID_PAYMENT_ENTITY"
  | "NON_PENDING_ORDER"
  | "ORDER_OR_AMOUNT_MISMATCH"
  | "NOT_CAPTURED_OR_REFUNDED"
  | "AUTHENTICATED_CANDIDATE_ONLY";

export interface RazorpayWebhookReview {
  readonly classification: "NEEDS_REVIEW";
  /** HMAC valid under the configured secret; NOT verification of funds. */
  readonly webhookAuthenticated: boolean;
  readonly paymentVerified: false;
  readonly canFulfill: false;
  readonly reason: RazorpayReviewReason;
}

function response(
  reason: RazorpayReviewReason,
  webhookAuthenticated = false,
): RazorpayWebhookReview {
  return {
    classification: "NEEDS_REVIEW",
    webhookAuthenticated,
    paymentVerified: false,
    canFulfill: false,
    reason,
  };
}

function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function exactPaise(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0;
}

/**
 * HMAC-SHA256 over EXACT raw webhook request bytes (never re-serialized JSON).
 *
 * `webhookSecret` is the Razorpay dashboard webhook signing secret, NOT
 * the Razorpay API key secret. We enforce a local >=32-character secret policy
 * so this candidate cannot silently use a trivially weak configured secret.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0 ||
      rawBody.byteLength > MAX_WEBHOOK_BYTES ||
      typeof signatureHeader !== "string" || !HEX_SHA256.test(signatureHeader) ||
      typeof webhookSecret !== "string" || webhookSecret.length < 32 ||
      webhookSecret.length > 4096) {
    return false;
  }
  try {
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest();
    const supplied = Buffer.from(signatureHeader, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

/**
 * Verifies the raw webhook HMAC, then checks a single captured-event snapshot
 * against an existing immutable Aventas-to-Razorpay order association.
 *
 * A captured webhook may be replayed, arrive out of order, become refunded,
 * be delivered to an incorrect merchant environment or lack durable storage.
 * Therefore even AUTHENTICATED_CANDIDATE_ONLY is NOT authority to mark PAID.
 */
export function screenRazorpayWebhookForReview(
  rawBody: Uint8Array,
  signatureHeader: string,
  webhookSecret: string,
  order: RazorpayPendingOrderSnapshot,
): RazorpayWebhookReview {
  if (!(rawBody instanceof Uint8Array) || !order ||
      typeof order.razorpayOrderId !== "string" ||
      !RAZORPAY_ORDER_ID.test(order.razorpayOrderId) ||
      !exactPaise(order.amountPaise) || order.currency !== "INR" ||
      !["PENDING", "PAID", "EXPIRED", "CANCELLED"].includes(order.status)) {
    return response("INVALID_INPUT");
  }
  if (!verifyRazorpayWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    return response("INVALID_WEBHOOK_SIGNATURE");
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return response("INVALID_JSON", true);
  }
  if (!record(body) || body.event !== "payment.captured") {
    return response("UNSUPPORTED_EVENT", true);
  }
  const payload = body.payload;
  const payment = record(payload) ? payload.payment : null;
  const entity = record(payment) ? payment.entity : null;
  if (!record(entity) ||
      typeof entity.id !== "string" || !RAZORPAY_PAYMENT_ID.test(entity.id) ||
      typeof entity.order_id !== "string" ||
      !RAZORPAY_ORDER_ID.test(entity.order_id) ||
      !exactPaise(entity.amount) ||
      typeof entity.currency !== "string" ||
      typeof entity.status !== "string" ||
      typeof entity.captured !== "boolean" ||
      (entity.amount_refunded !== undefined &&
        (!Number.isSafeInteger(entity.amount_refunded) ||
         typeof entity.amount_refunded !== "number" ||
         entity.amount_refunded < 0))) {
    return response("INVALID_PAYMENT_ENTITY", true);
  }
  if (order.status !== "PENDING") {
    return response("NON_PENDING_ORDER", true);
  }
  if (entity.order_id !== order.razorpayOrderId ||
      entity.amount !== order.amountPaise || entity.currency !== "INR") {
    return response("ORDER_OR_AMOUNT_MISMATCH", true);
  }
  if (entity.status !== "captured" || entity.captured !== true ||
      (entity.amount_refunded !== undefined && entity.amount_refunded !== 0) ||
      (entity.refund_status !== undefined && entity.refund_status !== null)) {
    return response("NOT_CAPTURED_OR_REFUNDED", true);
  }
  return response("AUTHENTICATED_CANDIDATE_ONLY", true);
}
