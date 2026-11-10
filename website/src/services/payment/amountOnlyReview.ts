/**
 * Pure, offline amount-only email reconciliation suggestions.
 *
 * NEVER a verifier, payer identity check, bank balance lookup or quote editor.
 * Decimal suggestions require an independently approved final-price policy and
 * a transactionally enforced reservation ledger before any checkout wiring.
 * Email-derived matches remain customer-support hints only.
 */
import type { UntrustedPaymentEvidence } from "./emailEvidenceParser";

export type ReviewOrderState = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

export interface ReviewOrderSnapshot {
  readonly orderId: string;
  /** Immutable, previously accepted amount from the order record. */
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly status: ReviewOrderState;
  /** Trusted, persisted server time at which this order-specific UPI QR was displayed. */
  readonly paymentWindowStartMs?: number;
  /** Trusted, persisted server checkout expiry, never an email-provided value. */
  readonly paymentWindowEndMs?: number;
}

export interface AmountOnlyReviewResult {
  readonly classification: "NEEDS_REVIEW";
  readonly paymentVerified: false;
  readonly canFulfill: false;
  readonly match:
    | "UNUSABLE_EMAIL_AMOUNT"
    | "NO_MATCH"
    | "MULTIPLE_MATCHES"
    | "NON_PENDING_ORDER"
    | "SINGLE_POSSIBLE_ORDER"
    | "TIME_DATA_MISSING"
    | "OUTSIDE_PAYMENT_WINDOW";
  readonly candidateOrderId: string | null;
}

/**
 * Suggests one unused fractional amount for an integer-rupee base.
 *
 * This does NOT reserve or persist it, and MUST NOT be called to silently
 * change an existing order's price. Callers must include retained/late-payment
 * amounts in occupiedAmountsPaise; a production implementation needs a unique
 * DB reservation inside an atomic order/price transaction.
 */
export function suggestUnusedFractionalAmountPaise(
  wholeRupeeAmountPaise: number,
  occupiedAmountsPaise: readonly number[],
): number | null {
  if (!Number.isSafeInteger(wholeRupeeAmountPaise) ||
      wholeRupeeAmountPaise <= 0 || wholeRupeeAmountPaise % 100 !== 0 ||
      wholeRupeeAmountPaise > Number.MAX_SAFE_INTEGER - 99 ||
      !Array.isArray(occupiedAmountsPaise) ||
      !occupiedAmountsPaise.every((amount) => Number.isSafeInteger(amount) && amount > 0)) {
    return null;
  }
  const occupied = new Set(occupiedAmountsPaise);
  for (let fractional = 1; fractional <= 99; fractional += 1) {
    const candidate = wholeRupeeAmountPaise + fractional;
    if (!occupied.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Returns a tentative candidate for staff review, never a verified payment.
 * Include all orders in the late-payment/reconciliation window, including
 * terminal orders, so a repeated amount cannot look uniquely attributable.
 */
export function correlateUntrustedEmailAmount(
  evidence: UntrustedPaymentEvidence,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
): AmountOnlyReviewResult {
  return findReviewCandidate(evidence, ordersInReconciliationWindow, false);
}

/** Consider expired orders only when the caller will verify the arrival window. */
function findReviewCandidate(
  evidence: UntrustedPaymentEvidence,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
  includeExpired: boolean,
): AmountOnlyReviewResult {
  const fail = (match: AmountOnlyReviewResult["match"]): AmountOnlyReviewResult => ({
    classification: "NEEDS_REVIEW",
    paymentVerified: false,
    canFulfill: false,
    match,
    candidateOrderId: null,
  });
  const amount = evidence?.reportedAmountPaise;
  if (evidence?.classification !== "NEEDS_REVIEW" || typeof amount !== "number" ||
      !Number.isSafeInteger(amount) || amount <= 0) {
    return fail("UNUSABLE_EMAIL_AMOUNT");
  }
  const matches = ordersInReconciliationWindow.filter((order) =>
    order.currency === "INR" &&
    Number.isSafeInteger(order.amountPaise) &&
    order.amountPaise === amount &&
    typeof order.orderId === "string" &&
    order.orderId.length > 0,
  );
  if (matches.length === 0) return fail("NO_MATCH");
  if (matches.length !== 1) return fail("MULTIPLE_MATCHES");
  const status = matches[0]!.status;
  if (status !== "PENDING" && !(includeExpired && status === "EXPIRED")) {
    return fail("NON_PENDING_ORDER");
  }
  return {
    ...fail("SINGLE_POSSIBLE_ORDER"),
    candidateOrderId: matches[0]!.orderId,
  };
}

/**
 * Adds a strict email-arrival-time window to the existing exact-amount
 * review candidate. Date and time are *additional filters*, NEVER payment
 * authorization. Every same-amount order in the reconciliation horizon
 * still counts for ambiguity, even if its own time range differs.
 *
 * Only pass Gmail message.internalDate (provider mailbox receipt time);
 * ignore the editable Date header or timestamps printed in message bodies.
 * The order window MUST originate from the trusted checkout/order store.
 */
export function correlateUntrustedEmailAmountWithReceivedTime(
  evidence: UntrustedPaymentEvidence,
  gmailReceivedAtMs: number | null | undefined,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
): AmountOnlyReviewResult {
  // Pagination or a restart can process an in-window alert after expiry.
  // Expired orders are review candidates only when the trusted arrival window matches.
  const base = findReviewCandidate(evidence, ordersInReconciliationWindow, true);
  if (base.match !== "SINGLE_POSSIBLE_ORDER") return base;

  const reject = (match: AmountOnlyReviewResult["match"]): AmountOnlyReviewResult => ({
    classification: "NEEDS_REVIEW", paymentVerified: false, canFulfill: false,
    match, candidateOrderId: null,
  });
  const order = ordersInReconciliationWindow.find((o) => o.orderId === base.candidateOrderId);
  const start = order?.paymentWindowStartMs;
  const end = order?.paymentWindowEndMs;
  const GRACE_MS = 2 * 60 * 1000; // Mail delivery delay only, not a payment extension.
  const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
  if (typeof gmailReceivedAtMs !== "number" ||
      !Number.isSafeInteger(gmailReceivedAtMs) || gmailReceivedAtMs <= 0 ||
      typeof start !== "number" || !Number.isSafeInteger(start) || start <= 0 ||
      typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0 ||
      end < start || end - start > MAX_WINDOW_MS ||
      end > Number.MAX_SAFE_INTEGER - GRACE_MS) {
    return reject("TIME_DATA_MISSING");
  }
  if (gmailReceivedAtMs < start || gmailReceivedAtMs > end + GRACE_MS) {
    return reject("OUTSIDE_PAYMENT_WINDOW");
  }
  return base;
}
