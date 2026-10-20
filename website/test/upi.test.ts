import { describe, expect, test } from "bun:test";
import { buildUpiPayload, formatInrDisplay, formatRupees } from "../src/domain/upi";
import { CheckoutSession } from "../src/domain/types";

const session: CheckoutSession = {
  id: "sess-1",
  orderId: "AVT-2026-000123",
  discordUserId: "123456789012345678",
  productId: "vp-1000",
  productName: "1000 Valorant Points",
  amountPaise: 99900,
  currency: "INR",
  paymentProfileId: "primary",
  upi: { vpa: "merchant@upi", displayName: "Aventas Store" },
  status: "PENDING",
  idempotencyKey: "AVT-2026-000123:checkout-session",
  attempt: 1,
  source: "discord_bot",
  providerTransactionRef: null,
  createdAt: new Date("2026-10-20T10:00:00Z"),
  updatedAt: new Date("2026-10-20T10:00:00Z"),
  expiresAt: new Date("2026-10-20T10:30:00Z"),
  paidAt: null,
};

describe("UPI payload", () => {
  test("contains exactly the stored recipient and amount", () => {
    const payload = buildUpiPayload(session);
    expect(payload.startsWith("upi://pay?")).toBe(true);
    expect(payload).toContain("pa=merchant%40upi");
    expect(payload).toContain("pn=Aventas%20Store");
    expect(payload).toContain("am=999.00");
    expect(payload).toContain("cu=INR");
    expect(payload).toContain("tn=Aventas%20order%20AVT-2026-000123");
  });

  test("is deterministic for the same session (QR stability across reloads)", () => {
    expect(buildUpiPayload(session)).toBe(buildUpiPayload(session));
  });

  test("reflects amount changes only through the stored session, not request input", () => {
    const cheaper: CheckoutSession = { ...session, amountPaise: 100 };
    expect(buildUpiPayload(cheaper)).toContain("am=1.00");
    // The original payload is untouched by the existence of another session.
    expect(buildUpiPayload(session)).toContain("am=999.00");
  });

  test("uses %20 for spaces, not '+', for UPI app compatibility", () => {
    expect(buildUpiPayload(session)).not.toContain("+");
  });

  test("formats rupees with exactly two decimals", () => {
    expect(formatRupees(1)).toBe("0.01");
    expect(formatRupees(100)).toBe("1.00");
    expect(formatRupees(99900)).toBe("999.00");
    expect(formatRupees(100000000)).toBe("1000000.00");
  });

  test("rejects invalid amounts", () => {
    expect(() => formatRupees(-1)).toThrow();
    expect(() => formatRupees(10.5)).toThrow();
  });

  test("Indian digit grouping for display", () => {
    expect(formatInrDisplay(100)).toBe("1.00");
    expect(formatInrDisplay(100000)).toBe("1,000.00");
    expect(formatInrDisplay(123456789)).toBe("12,34,567.89");
    expect(formatInrDisplay(100000000)).toBe("10,00,000.00");
  });
});
