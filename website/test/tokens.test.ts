import { describe, expect, test } from "bun:test";
import {
  constantTimeEqual,
  deriveCheckoutToken,
  hashCheckoutToken,
  looksLikeCheckoutToken,
} from "../src/domain/tokens";

const SECRET = "test-secret-value-at-least-16-chars";

describe("checkout tokens", () => {
  test("derivation is deterministic for the same session id", async () => {
    const a = await deriveCheckoutToken(SECRET, "session-1");
    const b = await deriveCheckoutToken(SECRET, "session-1");
    expect(a).toBe(b);
  });

  test("different sessions and different secrets produce different tokens", async () => {
    const a = await deriveCheckoutToken(SECRET, "session-1");
    const b = await deriveCheckoutToken(SECRET, "session-2");
    const c = await deriveCheckoutToken(SECRET + "x", "session-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test("token is base64url and 43 chars (256-bit)", async () => {
    const token = await deriveCheckoutToken(SECRET, "session-1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeCheckoutToken(token)).toBe(true);
  });

  test("rejects weak secrets", async () => {
    await expect(deriveCheckoutToken("short", "session-1")).rejects.toThrow();
  });

  test("hash is stable sha256 hex and does not contain the token", async () => {
    const token = await deriveCheckoutToken(SECRET, "session-1");
    const h1 = await hashCheckoutToken(token);
    const h2 = await hashCheckoutToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(token);
  });

  test("constant-time compare matches equal strings and rejects different ones", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("", "abc")).toBe(false);
    // Length differences must not break the comparison semantics.
    expect(await constantTimeEqual("a", "abcdef")).toBe(false);
  });

  test("tokens are unique across many sessions (2000 samples)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      seen.add(await deriveCheckoutToken(SECRET, crypto.randomUUID()));
    }
    expect(seen.size).toBe(2000);
  });

  test("token shape validator rejects malformed candidates", () => {
    expect(looksLikeCheckoutToken("short")).toBe(false);
    expect(looksLikeCheckoutToken("a".repeat(44))).toBe(false);
    expect(looksLikeCheckoutToken("!".repeat(43))).toBe(false);
    expect(looksLikeCheckoutToken(null)).toBe(false);
    expect(looksLikeCheckoutToken(12345)).toBe(false);
  });
});
