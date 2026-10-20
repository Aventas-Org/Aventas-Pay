/**
 * SQL-backed sliding-window rate limiter.
 *
 * Correct across Worker isolates because all state lives in one row per bucket
 * in the shared database, updated with a single atomic UPSERT ... RETURNING
 * statement (SQLite 3.35+, which both bun:sqlite and D1 support).
 *
 * Semantics match InMemoryRateLimiter exactly:
 *   - window is a fixed window of `windowSeconds` anchored at first request;
 *   - consuming beyond the limit returns the retry-after seconds;
 *   - buckets prune themselves when they roll over.
 */

import { RateLimiter } from "../domain/rateLimit";
import { SqlExecutor } from "./sqlPort";

const UPSERT_SQL = `
INSERT INTO checkout_rate_limits (bucket, window_start_ms, count)
VALUES (?, ?, 1)
ON CONFLICT(bucket) DO UPDATE SET
  count = CASE WHEN (? - window_start_ms) >= ? THEN 1 ELSE count + 1 END,
  window_start_ms = CASE WHEN (? - window_start_ms) >= ? THEN ? ELSE window_start_ms END
RETURNING count, window_start_ms
`;

interface LimiterRow {
  count: number;
  window_start_ms: number;
}

export class SqlRateLimiter implements RateLimiter {
  constructor(
    private readonly db: SqlExecutor,
    /** Prune rows older than this on each consume; bounds table growth. */
    private readonly pruneOlderThanMs = 3_600_000,
  ) {}

  async consume(
    bucket: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<number | null> {
    const nowMs = now.getTime();
    const windowMs = windowSeconds * 1000;

    const row = await this.db.get<LimiterRow>(UPSERT_SQL, [
      bucket,
      nowMs,
      nowMs,
      windowMs,
      nowMs,
      windowMs,
      nowMs,
    ]);
    if (!row) return null; // unreachable: UPSERT always returns a row

    if (row.count > limit) {
      const remainingMs = row.window_start_ms + windowMs - nowMs;
      return Math.max(1, Math.ceil(remainingMs / 1000));
    }

    // Opportunistic, cheap pruning of long-idle buckets.
    if (Math.random() < 0.01) {
      await this.prune(now);
    }
    return null;
  }

  /**
   * Removes buckets idle for longer than the retention window. Called
   * probabilistically from consume(); public so maintenance jobs and tests can
   * trigger it deterministically.
   */
  async prune(now: Date): Promise<void> {
    try {
      await this.db.run("DELETE FROM checkout_rate_limits WHERE window_start_ms < ?", [
        now.getTime() - this.pruneOlderThanMs,
      ]);
    } catch {
      // best-effort maintenance only; never affect request handling
    }
  }
}
