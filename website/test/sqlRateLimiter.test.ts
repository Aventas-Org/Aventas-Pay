/**
 * SQL-backed rate limiter tests against real SQLite (D1's engine family).
 */

import { describe, expect, test } from "bun:test";
import { SqlRateLimiter } from "../src/adapters/sqlRateLimiter";
import { migratedExecutor } from "./helpers/bunSqlite";

const T0 = new Date("2026-10-20T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("SqlRateLimiter", () => {
  test("allows up to the limit then reports retry-after", async () => {
    const { executor } = migratedExecutor();
    const limiter = new SqlRateLimiter(executor);
    for (let i = 0; i < 5; i++) {
      expect(await limiter.consume("ip:1", 5, 60, T0)).toBeNull();
    }
    const retryAfter = await limiter.consume("ip:1", 5, 60, T0);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("buckets are independent", async () => {
    const { executor } = migratedExecutor();
    const limiter = new SqlRateLimiter(executor);
    expect(await limiter.consume("ip:1", 1, 60, T0)).toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, T0)).not.toBeNull();
    expect(await limiter.consume("ip:2", 1, 60, T0)).toBeNull();
  });

  test("window rollover resets the count", async () => {
    const { executor } = migratedExecutor();
    const limiter = new SqlRateLimiter(executor);
    expect(await limiter.consume("ip:1", 1, 60, T0)).toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, T0)).not.toBeNull();
    expect(await limiter.consume("ip:1", 1, 60, at(61))).toBeNull();
  });

  test("state survives a new limiter instance (shared across isolates)", async () => {
    const { executor } = migratedExecutor();
    // Two separate limiter objects, as two Worker isolates would have, share
    // the same database and therefore the same counters.
    const isolateA = new SqlRateLimiter(executor);
    const isolateB = new SqlRateLimiter(executor);
    expect(await isolateA.consume("ip:1", 2, 60, T0)).toBeNull();
    expect(await isolateB.consume("ip:1", 2, 60, T0)).toBeNull();
    expect(await isolateA.consume("ip:1", 2, 60, T0)).not.toBeNull();
  });

  test("state survives reopening the database file (durability)", async () => {
    const { Database } = await import("bun:sqlite");
    const { BunSqliteExecutor, applyMigrations } = await import("./helpers/bunSqlite");
    const file = `/tmp/avantas-ratelimit-${crypto.randomUUID()}.sqlite`;
    try {
      const db1 = new Database(file, { create: true });
      applyMigrations(db1);
      const limiter1 = new SqlRateLimiter(new BunSqliteExecutor(db1));
      expect(await limiter1.consume("ip:1", 1, 60, T0)).toBeNull();
      db1.close(); // simulate isolate recycling / restart

      const db2 = new Database(file);
      const limiter2 = new SqlRateLimiter(new BunSqliteExecutor(db2));
      // The counter survived the reopen: this request must be limited.
      expect(await limiter2.consume("ip:1", 1, 60, T0)).not.toBeNull();
      db2.close();
    } finally {
      try {
        await Bun.write(file, "");
        const { unlink } = await import("node:fs/promises");
        await unlink(file);
      } catch {
        // temp cleanup is best-effort
      }
    }
  });

  test("concurrent consumes are atomic (no lost updates)", async () => {
    const { executor } = migratedExecutor();
    const limiter = new SqlRateLimiter(executor);
    // 20 concurrent consumes against a limit of 10: exactly 10 may pass.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume("burst", 10, 60, T0)),
    );
    const allowed = results.filter((r) => r === null).length;
    expect(allowed).toBe(10);
  });

  test("pruning removes stale buckets without touching live ones", async () => {
    const { executor, db } = migratedExecutor();
    const limiter = new SqlRateLimiter(executor, 3_600_000);
    await limiter.consume("stale", 10, 60, at(-7200)); // two hours old
    await limiter.consume("live", 10, 60, T0);
    // Deterministic trigger (the consume() path calls this probabilistically).
    await limiter.prune(T0);
    const rows = db
      .query("SELECT bucket FROM checkout_rate_limits WHERE bucket IN ('stale', 'live')")
      .all() as Array<{ bucket: string }>;
    const names = rows.map((r) => r.bucket);
    expect(names).toContain("live");
    expect(names).not.toContain("stale");
  });
});
