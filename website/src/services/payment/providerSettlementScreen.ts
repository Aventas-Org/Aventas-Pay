/**
 * Pure pre-screening for *candidate* provider settlement records.
 *
 * NOT an authentication, signature verifier, API client, replay ledger, receipt
 * verifier or fulfillment path. Provider integrations MUST independently verify
 * signatures, retrieve provider status, persist unique payment/event IDs and
 * reconcile settlement before using any resulting order transition.
 *
 * No result from this function authorizes a PAID transition.
 */
export interface ProviderOrderSnapshot {
  readonly authority: "manual_verified" | "provider_verified";
  readonly status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  readonly providerId: string;
  readonly merchantAccountId: string;
  readonly providerOrderId: string;
  readonly orderId: string;
  /** Buyer identity stored in the immutable Aventas order/payment record. */
  readonly buyerId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly taxQuoteHash: string | null;
}

/** An untrusted record until a real provider adapter authenticates it. */
export interface UntrustedProviderPaymentRecord {
  readonly providerId: string;
  readonly merchantAccountId: string;
  readonly providerOrderId: string;
  readonly paymentId: string;
  readonly eventId: string;
  readonly orderId: string;
  readonly buyerId: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly financialState: string;
  readonly settlementState: string;
  readonly riskState: "CLEAR" | "REFUNDED" | "CHARGEBACK" | "UNKNOWN";
  readonly taxQuoteHash: string | null;
}

/**
 * Lists must come from provider-specific versioned docs and merchant approvals.
 * They are NOT a source of authentication or authority.
 */
export interface ProviderStatePolicy {
  readonly providerId: string;
  readonly payableFinancialStates: readonly string[];
  readonly payableSettlementStates: readonly string[];
}

export interface ExistingProviderPayment {
  readonly providerId: string;
  readonly paymentId: string;
  readonly orderId: string;
}

export type ProviderScreeningReason =
  | "INVALID_INPUT"
  | "NO_APPROVED_PROVIDER_STATE_POLICY"
  | "MANUAL_ONLY_ORDER"
  | "NON_PENDING_ORDER"
  | "WRONG_PROVIDER"
  | "WRONG_MERCHANT"
  | "WRONG_ORDER_OR_BUYER"
  | "WRONG_AMOUNT_OR_CURRENCY"
  | "TAX_QUOTE_MISMATCH"
  | "DUPLICATE_PAYMENT_CONFLICT"
  | "PREVIOUSLY_RECORDED"
  | "REFUND_OR_DISPUTE"
  | "UNAPPROVED_PROVIDER_STATE"
  | "MATCH_CANDIDATE_ONLY";

export interface ProviderScreeningResult {
  readonly classification: "NEEDS_REVIEW";
  readonly paymentVerified: false;
  readonly canFulfill: false;
  readonly reason: ProviderScreeningReason;
}

function validId(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(x);
}

function validAmount(x: unknown): x is number {
  return Number.isSafeInteger(x) && typeof x === "number" && x > 0;
}

function validQuote(x: unknown): x is string | null {
  return x === null || (typeof x === "string" && /^[a-fA-F0-9]{64}$/.test(x));
}

function allowedStates(xs: unknown): xs is readonly string[] {
  return Array.isArray(xs) && xs.length > 0 && xs.length <= 16 &&
    xs.every((x) => typeof x === "string" && validId(x));
}

function result(reason: ProviderScreeningReason): ProviderScreeningResult {
  return { classification: "NEEDS_REVIEW", paymentVerified: false, canFulfill: false, reason };
}

/**
 * Fail-closed, side-effect-free screening. Every outcome is NEEDS_REVIEW.
 *
 * Even MATCH_CANDIDATE_ONLY requires independent provider authentication,
 * authoritative payment-status lookup, recipient/merchant reconciliation,
 * durable event + payment uniqueness, tax/legal review, and separate release
 * authorization. This function cannot mark any order paid.
 */
export function screenUntrustedProviderPayment(
  order: ProviderOrderSnapshot,
  record: UntrustedProviderPaymentRecord,
  policy: ProviderStatePolicy | null,
  priorPayments: readonly ExistingProviderPayment[],
): ProviderScreeningResult {
  if (!order || !record || !Array.isArray(priorPayments) ||
      !validId(order.orderId) || !validId(order.buyerId) ||
      !validId(order.providerId) || !validId(order.merchantAccountId) ||
      !validId(order.providerOrderId) || !validAmount(order.amountPaise) ||
      order.currency !== "INR" || !validQuote(order.taxQuoteHash) ||
      !validId(record.providerId) || !validId(record.merchantAccountId) ||
      !validId(record.providerOrderId) || !validId(record.paymentId) ||
      !validId(record.eventId) || !validId(record.orderId) ||
      !validId(record.buyerId) || !validAmount(record.amountPaise) ||
      typeof record.currency !== "string" ||
      !validId(record.financialState) || !validId(record.settlementState) ||
      !validQuote(record.taxQuoteHash) ||
      !priorPayments.every((p) => p && validId(p.providerId) &&
        validId(p.paymentId) && validId(p.orderId))) {
    return result("INVALID_INPUT");
  }
  if (!policy || !validId(policy.providerId) ||
      !allowedStates(policy.payableFinancialStates) ||
      !allowedStates(policy.payableSettlementStates) ||
      policy.providerId !== order.providerId) {
    return result("NO_APPROVED_PROVIDER_STATE_POLICY");
  }
  if (order.authority !== "provider_verified") return result("MANUAL_ONLY_ORDER");
  if (order.status !== "PENDING") return result("NON_PENDING_ORDER");
  if (order.providerId !== record.providerId) return result("WRONG_PROVIDER");
  if (order.merchantAccountId !== record.merchantAccountId) return result("WRONG_MERCHANT");
  if (order.orderId !== record.orderId || order.buyerId !== record.buyerId ||
      order.providerOrderId !== record.providerOrderId) {
    return result("WRONG_ORDER_OR_BUYER");
  }
  if (record.currency !== "INR" || order.amountPaise !== record.amountPaise) {
    return result("WRONG_AMOUNT_OR_CURRENCY");
  }
  if (order.taxQuoteHash !== record.taxQuoteHash) return result("TAX_QUOTE_MISMATCH");
  const previous = priorPayments.filter((p) =>
    p.providerId === record.providerId && p.paymentId === record.paymentId);
  if (previous.some((p) => p.orderId !== order.orderId) || previous.length > 1) {
    return result("DUPLICATE_PAYMENT_CONFLICT");
  }
  if (previous.length === 1) return result("PREVIOUSLY_RECORDED");
  if (record.riskState !== "CLEAR") return result("REFUND_OR_DISPUTE");
  if (!policy.payableFinancialStates.includes(record.financialState) ||
      !policy.payableSettlementStates.includes(record.settlementState)) {
    return result("UNAPPROVED_PROVIDER_STATE");
  }
  return result("MATCH_CANDIDATE_ONLY");
}
