import { describe, expect, test } from "bun:test";
import {
  screenUntrustedProviderPayment,
  type ProviderOrderSnapshot,
  type UntrustedProviderPaymentRecord,
  type ProviderStatePolicy,
  type ExistingProviderPayment,
  type ProviderScreeningReason,
} from "../src/services/payment/providerSettlementScreen";

const hash = "a".repeat(64);
const order: ProviderOrderSnapshot = {
  authority: "provider_verified", status: "PENDING",
  providerId: "provider-a", merchantAccountId: "merchant-a",
  providerOrderId: "pay-order-a", orderId: "AVT-1", buyerId: "buyer-1",
  amountPaise: 48024, currency: "INR", taxQuoteHash: hash,
};
const record: UntrustedProviderPaymentRecord = {
  providerId: "provider-a", merchantAccountId: "merchant-a",
  providerOrderId: "pay-order-a", paymentId: "payment-1",
  eventId: "event-1", orderId: "AVT-1", buyerId: "buyer-1",
  amountPaise: 48024, currency: "INR", taxQuoteHash: hash,
  financialState: "DOC_APPROVED_CAPTURED",
  settlementState: "DOC_APPROVED_SETTLED", riskState: "CLEAR",
};
/** Synthetic state names are not assertions about any real provider's API. */
const policy: ProviderStatePolicy = {
  providerId: "provider-a",
  payableFinancialStates: ["DOC_APPROVED_CAPTURED"],
  payableSettlementStates: ["DOC_APPROVED_SETTLED"],
};
const previous: ExistingProviderPayment = {
  providerId: "provider-a", paymentId: "payment-1", orderId: "AVT-1",
};
function screen(
  updatedOrder: ProviderOrderSnapshot = order,
  updatedRecord: UntrustedProviderPaymentRecord = record,
  updatedPolicy: ProviderStatePolicy | null = policy,
  prior: readonly ExistingProviderPayment[] = [],
) {
  return screenUntrustedProviderPayment(updatedOrder, updatedRecord, updatedPolicy, prior);
}
function denied(reason: ProviderScreeningReason, res: ReturnType<typeof screen>) {
  expect(res.reason).toBe(reason);
  expect(res.classification).toBe("NEEDS_REVIEW");
  expect(res.paymentVerified).toBe(false);
  expect(res.canFulfill).toBe(false);
  expect(res).not.toHaveProperty("status", "PAID");
}

describe("provider record screening is not an approval mechanism", () => {
  test("even every matching field only returns an unverified candidate", () => {
    denied("MATCH_CANDIDATE_ONLY", screen());
  });
  test("cannot use a manual-only order", () => {
    denied("MANUAL_ONLY_ORDER", screen({ ...order, authority: "manual_verified" }));
  });
  test.each(["PAID", "EXPIRED", "CANCELLED"] as const)(
    "blocks terminal order %s", (status) => {
      denied("NON_PENDING_ORDER", screen({ ...order, status }));
    },
  );
  test("rejects wrong provider, merchant, order, buyer and provider order reference", () => {
    denied("WRONG_PROVIDER", screen(order, { ...record, providerId: "provider-b" }));
    denied("WRONG_MERCHANT", screen(order, { ...record, merchantAccountId: "merchant-b" }));
    for (const field of ["orderId", "buyerId", "providerOrderId"] as const) {
      denied("WRONG_ORDER_OR_BUYER", screen(order, { ...record, [field]: "wrong" }));
    }
  });
  test("rejects amount mismatch, missing paise, overflow and currency mismatch", () => {
    denied("WRONG_AMOUNT_OR_CURRENCY", screen(order, { ...record, amountPaise: 48000 }));
    denied("WRONG_AMOUNT_OR_CURRENCY", screen(order, { ...record, currency: "USD" }));
    denied("INVALID_INPUT", screen(order, { ...record, amountPaise: Number.MAX_SAFE_INTEGER + 1 }));
    denied("INVALID_INPUT", screen(order, { ...record, amountPaise: NaN }));
    denied("INVALID_INPUT", screen({ ...order, amountPaise: 0 }));
  });
  test("requires exact signed finance quote binding when stored", () => {
    denied("TAX_QUOTE_MISMATCH", screen(order, { ...record, taxQuoteHash: "b".repeat(64) }));
    denied("TAX_QUOTE_MISMATCH", screen(order, { ...record, taxQuoteHash: null }));
    denied("INVALID_INPUT", screen(order, { ...record, taxQuoteHash: "not-a-sha" }));
    denied("MATCH_CANDIDATE_ONLY", screen(
      { ...order, taxQuoteHash: null },
      { ...record, taxQuoteHash: null },
    ));
  });
  test("duplicate provider payment cannot be used for another order or approved again", () => {
    denied("PREVIOUSLY_RECORDED", screen(order, record, policy, [previous]));
    denied("DUPLICATE_PAYMENT_CONFLICT", screen(order, record, policy, [
      { ...previous, orderId: "AVT-other" },
    ]));
    denied("DUPLICATE_PAYMENT_CONFLICT", screen(order, record, policy, [previous, previous]));
  });
  test.each(["REFUNDED", "CHARGEBACK", "UNKNOWN"] as const)(
    "blocks risk state %s even when all other properties match", (riskState) => {
      denied("REFUND_OR_DISPUTE", screen(order, { ...record, riskState }));
    },
  );
  test("unrecognized provider financial or settlement statuses do not pass screening", () => {
    denied("UNAPPROVED_PROVIDER_STATE", screen(order, { ...record, financialState: "CREATED" }));
    denied("UNAPPROVED_PROVIDER_STATE", screen(order, { ...record, settlementState: "PENDING" }));
  });
  test("no default or malformed state policy is accepted", () => {
    denied("NO_APPROVED_PROVIDER_STATE_POLICY", screen(order, record, null));
    denied("NO_APPROVED_PROVIDER_STATE_POLICY", screen(order, record, {
      ...policy, payableFinancialStates: [],
    }));
    denied("NO_APPROVED_PROVIDER_STATE_POLICY", screen(order, record, {
      ...policy, providerId: "provider-b",
    }));
  });
  test("cannot trust malformed fields, metadata or prior ledger records", () => {
    denied("INVALID_INPUT", screen(order, { ...record, paymentId: "" }));
    denied("INVALID_INPUT", screen(order, { ...record, eventId: "not a safe id" }));
    denied("INVALID_INPUT", screen(order, record, policy, [
      { providerId: "provider-a", paymentId: "", orderId: "AVT-1" },
    ]));
    denied("INVALID_INPUT", screen(order, { ...record, financialState: "" }));
  });
  test("pure function never makes email amount, screenshot or customer UTR authoritative", () => {
    const r = screen();
    expect(Object.keys(r).sort()).toEqual([
      "canFulfill", "classification", "paymentVerified", "reason",
    ]);
    expect(r.canFulfill).toBe(false);
  });
});
