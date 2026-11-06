import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TTL_SECONDS,
  MAX_AMOUNT_PAISE,
  MIN_AMOUNT_PAISE,
  validateCreateSessionRequest,
} from "../src/domain/validation";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: "AVT-2026-000123",
    discord_user_id: "123456789012345678",
    product_id: "vp-1000",
    product_name: "1000 Valorant Points",
    amount_paise: 99900,
    currency: "INR",
    payment_profile_id: "primary",
    upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
    ...overrides,
  };
}

describe("validateCreateSessionRequest", () => {
  test("accepts a valid request and applies defaults", () => {
    const result = validateCreateSessionRequest(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orderId).toBe("AVT-2026-000123");
      expect(result.value.amountPaise).toBe(99900);
      expect(result.value.currency).toBe("INR");
      expect(result.value.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
      // Default idempotency key is derived from the order id.
      expect(result.value.idempotencyKey).toBe("AVT-2026-000123:checkout-session");
    }
  });

  test("rejects non-object bodies", () => {
    for (const bad of [null, "string", 42, ["array"]]) {
      const result = validateCreateSessionRequest(bad);
      expect(result.ok).toBe(false);
    }
  });

  test.each<[string, Record<string, unknown>]>([
    ["amount zero", { amount_paise: 0 }],
    ["amount negative", { amount_paise: -100 }],
    ["amount float", { amount_paise: 100.5 }],
    ["amount string", { amount_paise: "10000" }],
    ["amount below minimum", { amount_paise: MIN_AMOUNT_PAISE - 1 }],
    ["amount above maximum", { amount_paise: MAX_AMOUNT_PAISE + 1 }],
    ["amount unsafe integer", { amount_paise: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects malformed amount: %s", (_label, overrides) => {
    const result = validateCreateSessionRequest(validBody(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidFields).toContain("amount_paise");
  });

  test.each<[string, Record<string, unknown>]>([
    ["order id with injection chars", { order_id: "AVT'; DROP TABLE--" }],
    ["order id too long", { order_id: "a".repeat(65) }],
    ["order id empty", { order_id: "" }],
    ["order id non-string", { order_id: 12345 }],
  ])("rejects malformed order id: %s", (_label, overrides) => {
    const result = validateCreateSessionRequest(validBody(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidFields).toContain("order_id");
  });

  test.each<[string, Record<string, unknown>]>([
    ["short discord id", { discord_user_id: "12345" }],
    ["non-numeric discord id", { discord_user_id: "abcdefghij12345" }],
    ["too-long discord id", { discord_user_id: "1".repeat(21) }],
  ])("rejects malformed discord id: %s", (_label, overrides) => {
    const result = validateCreateSessionRequest(validBody(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidFields).toContain("discord_user_id");
  });

  test("rejects non-INR currency", () => {
    const result = validateCreateSessionRequest(validBody({ currency: "USD" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalidFields).toContain("currency");
  });

  test.each<[string, Record<string, unknown>]>([
    ["vpa without @", { upi: { vpa: "merchantupi", display_name: "Store" } }],
    ["vpa with spaces", { upi: { vpa: "merchant @upi", display_name: "Store" } }],
    ["vpa empty", { upi: { vpa: "", display_name: "Store" } }],
    ["missing display name", { upi: { vpa: "merchant@upi" } }],
    ["upi not object", { upi: "merchant@upi" }],
  ])("rejects malformed recipient: %s", (_label, overrides) => {
    const result = validateCreateSessionRequest(validBody(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Granular names ("upi.vpa", "upi.display_name") or the whole "upi" object.
      expect(
        result.invalidFields.some((f) => f === "upi" || f.startsWith("upi.")),
      ).toBe(true);
    }
  });

  test("rejects control characters in display text", () => {
    const result = validateCreateSessionRequest(
      validBody({ product_name: "Bad\u0000Name\u0007" }),
    );
    expect(result.ok).toBe(true); // control chars are stripped, not stored raw
    if (result.ok) expect(result.value.productName).toBe("BadName");
  });

  test("rejects out-of-range ttl and accepts bounded ttl", () => {
    const tooSmall = validateCreateSessionRequest(validBody({ ttl_seconds: 10 }));
    expect(tooSmall.ok).toBe(false);
    const tooBig = validateCreateSessionRequest(validBody({ ttl_seconds: 999999 }));
    expect(tooBig.ok).toBe(false);
    const ok = validateCreateSessionRequest(validBody({ ttl_seconds: 600 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.ttlSeconds).toBe(600);
  });

  test("rejects malformed idempotency key but accepts a valid one", () => {
    const bad = validateCreateSessionRequest(validBody({ idempotency_key: "x" }));
    expect(bad.ok).toBe(false);
    const good = validateCreateSessionRequest(
      validBody({ idempotency_key: "AVT-1:checkout-session" }),
    );
    expect(good.ok).toBe(true);
  });

  test("reports every invalid field at once", () => {
    const result = validateCreateSessionRequest(
      validBody({ order_id: "!", amount_paise: -5, currency: "EUR" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalidFields).toContain("order_id");
      expect(result.invalidFields).toContain("amount_paise");
      expect(result.invalidFields).toContain("currency");
    }
  });
});
