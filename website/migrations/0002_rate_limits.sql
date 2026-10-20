-- Stage 2 additive migration: durable rate-limit storage.
--
-- STATUS: tested against real SQLite (bun:sqlite) in
-- test/sqlRateLimiter.test.ts, the same engine family D1 runs on.
--
-- Why this exists: the Stage 1 in-memory limiter is per-isolate. In a
-- multi-isolate Worker deployment that is NOT sufficient abuse protection, so
-- production wiring must use either a Durable Object limiter or this SQL-backed
-- limiter. This table backs the SQL variant; the RateLimiter interface is
-- unchanged, so handlers do not care which is wired.
--
-- Tradeoff: a D1 round trip per request is slower than memory but survives
-- isolate recycling and is shared across all isolates hitting the same
-- database. For higher traffic, swap in a Durable Object limiter implementing
-- the same interface.

CREATE TABLE IF NOT EXISTS checkout_rate_limits (
  bucket          TEXT    PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  count           INTEGER NOT NULL
);

-- Lets the limiter prune stale buckets without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_checkout_rate_limits_window
  ON checkout_rate_limits (window_start_ms);
