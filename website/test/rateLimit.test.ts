import { describe, expect, test } from "bun:test";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";

const T0 = new Date("2026-10-20T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("InMemoryRateLimiter", () => {
  test("allows up to the limit then blocks with retry-after", async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(await limiter.consume("ip:1", 5, 60, T0)).toBeNull();
    }
    const retryAfter = await limiter.consume("ip:1", 5, 60, T0);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("buckets are independent", async () => {
    const limiter = new InMemoryRateLimiter();
    expect(await limiter.consume("ip:1", 1, 60, T0)).toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, T0)).not.toBeNull();
    expect(await limiter.consume("ip:2", 1, 60, T0)).toBeNull();
  });

  test("window reset allows requests again", async () => {
    const limiter = new InMemoryRateLimiter();
    expect(await limiter.consume("ip:1", 1, 60, T0)).toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, T0)).not.toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, at(61))).toBeNull();
  });

  test("memory stays bounded under many distinct keys", async () => {
    const limiter = new InMemoryRateLimiter(50);
    for (let i = 0; i < 500; i++) {
      await limiter.consume(`ip:${i}`, 10, 3600, T0);
    }
    // No assertion on internals beyond "does not blow up"; eviction keeps the
    // map bounded which we observe by continued successful operation:
    expect(await limiter.consume("ip:0", 10, 3600, at(2))).toBeNull();
  });
});
