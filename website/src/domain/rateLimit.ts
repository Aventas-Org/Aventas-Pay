/**
 * Sliding-window rate limiter for public endpoints.
 *
 * Stage 1 ships an in-memory implementation behind an interface: single-worker
 * and correct enough for rollout. On transplant into the Aventas-website Worker,
 * swap for a Durable Object or D1-backed limiter to survive isolates; the
 * interface and the handler behaviour stay identical.
 */

export interface RateLimiter {
  /**
   * Consumes one unit. Returns null when allowed, or retryAfter seconds when
   * limited. Async so durable implementations (D1/SQL-backed) can share the
   * same interface as the in-memory one.
   */
  consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<number | null> | number | null;
}

interface Window {
  windowStartMs: number;
  count: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxTrackedKeys: number;

  constructor(maxTrackedKeys = 10_000) {
    this.maxTrackedKeys = maxTrackedKeys;
  }

  consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): number | null {
    const nowMs = now.getTime();
    const windowMs = windowSeconds * 1000;
    let entry = this.windows.get(bucket);
    if (!entry || nowMs - entry.windowStartMs >= windowMs) {
      if (this.windows.size >= this.maxTrackedKeys) this.evictOldest(nowMs, windowMs);
      entry = { windowStartMs: nowMs, count: 0 };
      this.windows.set(bucket, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      const remainingMs = windowMs - (nowMs - entry.windowStartMs);
      return Math.max(1, Math.ceil(remainingMs / 1000));
    }
    return null;
  }

  private evictOldest(nowMs: number, windowMs: number): void {
    for (const [key, entry] of this.windows) {
      if (nowMs - entry.windowStartMs >= windowMs) this.windows.delete(key);
    }
    if (this.windows.size >= this.maxTrackedKeys) {
      // Still full of live windows: drop the oldest half to bound memory.
      const entries = [...this.windows.entries()].sort(
        (a, b) => a[1].windowStartMs - b[1].windowStartMs,
      );
      for (const [key] of entries.slice(0, Math.floor(entries.length / 2))) {
        this.windows.delete(key);
      }
    }
  }
}
