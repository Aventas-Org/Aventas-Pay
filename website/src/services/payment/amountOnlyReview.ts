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
    | "SINGLE_POSSIBLE_ORDER";
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
  if (matches[0]!.status !== "PENDING") return fail("NON_PENDING_ORDER");
  return {
    ...fail("SINGLE_POSSIBLE_ORDER"),
    candidateOrderId: matches[0]!.orderId,
  };
}
