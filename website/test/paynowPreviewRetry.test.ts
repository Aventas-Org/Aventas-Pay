import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqlSessionStore } from "../src/adapters/sqlSessionStore";
import type { SqlExecutor } from "../src/adapters/sqlPort";

const START = Date.parse("2026-11-18T06:00:00Z");
const clock = (deltaMs: number) => new Date(START + deltaMs);

function setup(source = "discord_bot_paynow") {
  const sqlite = new Database(":memory:");
  sqlite.run(readFileSync(join(import.meta.dir, "../migrations/0001_checkout_sessions.sql"), "utf8"));
  sqlite.run(`CREATE TABLE checkout_paynow_activations (
    session_id TEXT PRIMARY KEY REFERENCES checkout_sessions(id),
    activated_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`);
  const executor: SqlExecutor = {
    async run(sql, params) {
      const r = sqlite.prepare(sql).run(...params);
      return { rowsAffected: r.changes };
    },
    async get<T>(sql: string, params: (string | number | null)[]) {
      return (sqlite.prepare(sql).get(...params) ?? null) as T | null;
    },
    async all<T>(sql: string, params: (string | number | null)[]) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
  };
  const expiry = source === "discord_bot_paynow" ? 30 * 60_000 : 120_000;
  sqlite.prepare(`INSERT INTO checkout_sessions(
    id,order_id,discord_user_id,product_id,product_name,amount_paise,
    currency,payment_profile_id,upi_vpa,upi_display_name,status,
    idempotency_key,attempt,token_hash,source,provider_transaction_ref,
    created_at,updated_at,expires_at,paid_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "session-1", "AVT-RETRY-1", "123456789012345678",
    "vp-1000", "Test Purchase", 160026, "INR",
    "primary", "merchant@upi", "Aventas",
    "PENDING", "AVT-RETRY-1:checkout-session", 1,
    "a".repeat(64), source, null,
    START, START, START + expiry, null,
  );
  return { sqlite, store: new SqlSessionStore(executor) };
}

describe("Pay Now active preview / 120-second expired activation retry", () => {
  test("an unactivated preview stays reusable after the legacy 120-second threshold", async () => {
    const { store } = setup();
    const now = clock(3 * 60_000);
    const active = await store.findActiveByOrderId("AVT-RETRY-1", now);
    expect(active?.id).toBe("session-1");
    const latest = await store.findLatestByIdempotencyKey("AVT-RETRY-1:checkout-session", now);
    expect(latest?.status).toBe("PENDING");
  });

  test("expired Pay Now activation cannot be reused even while preview link remains valid", async () => {
    const { sqlite, store } = setup();
    sqlite.prepare("INSERT INTO checkout_paynow_activations VALUES (?,?,?)").run(
      "session-1", START + 20_000, START + 140_000
    );
    const now = clock(140_001);
    expect(await store.findActiveByOrderId("AVT-RETRY-1", now)).toBeNull();
    const latest = await store.findLatestByIdempotencyKey("AVT-RETRY-1:checkout-session", now);
    expect(latest?.status).toBe("EXPIRED");
    expect(latest?.attempt).toBe(1);
  });

  test("before activation deadline the same payable session is reused", async () => {
    const { sqlite, store } = setup();
    sqlite.prepare("INSERT INTO checkout_paynow_activations VALUES (?,?,?)").run(
      "session-1", START + 20_000, START + 140_000
    );
    const now = clock(139_999);
    expect((await store.findActiveByOrderId("AVT-RETRY-1", now))?.id).toBe("session-1");
    expect((await store.findLatestByIdempotencyKey("AVT-RETRY-1:checkout-session", now))?.status).toBe("PENDING");
  });

  test("legacy unactivated checkout still expires after two minutes", async () => {
    const { store } = setup("discord_bot");
    expect((await store.findActiveByOrderId("AVT-RETRY-1", clock(119_999)))?.id).toBe("session-1");
    expect(await store.findActiveByOrderId("AVT-RETRY-1", clock(120_001))).toBeNull();
  });
});
