import { describe, expect, test } from "bun:test";
import { CHECKOUT_OPERATION, deriveIdempotencyKey } from "../src/domain/idempotency";

describe("trusted checkout idempotency-key contract", () => {
  test("derives a stable key from order ID and the default checkout operation", () => {
    const order = "AVT-2026-000123";
    expect(deriveIdempotencyKey(order)).toBe(`${order}:${CHECKOUT_OPERATION}`);
    expect(deriveIdempotencyKey(order)).toBe(deriveIdempotencyKey(order));
  });

  test("different authorized operations have distinct keys for the same order", () => {
    const order = "AVT-2026-000123";
    expect(deriveIdempotencyKey(order, "refund-review")).toBe(`${order}:refund-review`);
    expect(deriveIdempotencyKey(order, "refund-review")).not.toBe(deriveIdempotencyKey(order));
  });
});
