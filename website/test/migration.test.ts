/**
 * Migration tests: the real migrations/0001_checkout_sessions.sql file is
 * applied to a genuine SQLite database (D1's engine family), then every
 * constraint and index the Stage 1 design relies on is verified for real.
 */

import { describe, expect, test } from "bun:test";
import { SqlSessionStore } from "../src/adapters/sqlSessionStore";
import { IdempotencyConflict } from "../src/domain/types";
import { applyMigrations, migratedExecutor, openDatabase } from "./helpers/bunSqlite";

const ROW = {
  id: "sess-1",
  order_id: "AVT-1",
  discord_user_id: "123456789012345678",
  product_id: "vp-1000",
  product_name: "1000 VP",
  amount_paise: 99900,
  currency: "INR",
  payment_profile_id: "primary",
  upi_vpa: "merchant@upi",
  upi_display_name: "Store",
  status: "PENDING",
  idempotency_key: "AVT-1:checkout-session",
  attempt: 1,
  token_hash: "hash-1",
  source: "discord_bot",
  provider_transaction_ref: null,
  created_at: "2026-10-20T10:00:00.000Z",
  updated_at: "2026-10-20T10:00:00.000Z",
  expires_at: "2026-10-20T10:30:00.000Z",
  paid_at: null,
};

function insertRaw(db: ReturnType<typeof openDatabase>, overrides: Partial<typeof ROW> = {}) {
  const row = { ...ROW, ...overrides };
  db.query(
    `INSERT INTO checkout_sessions (
      id, order_id, discord_user_id, product_id, product_name, amount_paise,
      currency, payment_profile_id, upi_vpa, upi_display_name, status,
      idempotency_key, attempt, token_hash, source, provider_transaction_ref,
      created_at, updated_at, expires_at, paid_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.order_id,
    row.discord_user_id,
    row.product_id,
    row.product_name,
    row.amount_paise,
    row.currency,
    row.payment_profile_id,
    row.upi_vpa,
    row.upi_display_name,
    row.status,
    row.idempotency_key,
    row.attempt,
    row.token_hash,
    row.source,
    row.provider_transaction_ref,
    row.created_at,
    row.updated_at,
    row.expires_at,
    row.paid_at,
  );
}

describe("0001_checkout_sessions.sql against real SQLite", () => {
  test("applies cleanly on an empty database", () => {
    const db = openDatabase();
    expect(() => applyMigrations(db)).not.toThrow();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("checkout_sessions");
    expect(names).toContain("checkout_session_events");
  });

  test("is idempotent (re-apply does not fail)", () => {
    const db = openDatabase();
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });

  test("declares the indexes token lookup, idempotency, order and expiry rely on", () => {
    const db = openDatabase();
    applyMigrations(db);
    const indexes = (
      db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_checkout_sessions_token_hash");
    expect(indexes).toContain("idx_checkout_sessions_idem");
    expect(indexes).toContain("idx_checkout_sessions_order");
    expect(indexes).toContain("idx_checkout_sessions_expires");
    expect(indexes).toContain("idx_checkout_session_events_session");
  });

  test("token_hash index is UNIQUE (tokens cannot collide across sessions)", () => {
    const db = openDatabase();
    applyMigrations(db);
    insertRaw(db);
    expect(() => insertRaw(db, { id: "sess-2", token_hash: "hash-1" })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  test("(idempotency_key, attempt) is UNIQUE (concurrent duplicates rejected)", () => {
    const db = openDatabase();
    applyMigrations(db);
    insertRaw(db);
    expect(() => insertRaw(db, { id: "sess-2", token_hash: "hash-2" })).toThrow(
      /UNIQUE constraint failed/,
    );
    // A different attempt under the same key is allowed.
    expect(() => insertRaw(db, { id: "sess-3", token_hash: "hash-3", attempt: 2 })).not.toThrow();
  });

  test("CHECK rejects non-positive amounts and non-INR currency", () => {
    const db = openDatabase();
    applyMigrations(db);
    expect(() => insertRaw(db, { amount_paise: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertRaw(db, { id: "s2", token_hash: "h2", amount_paise: -100 })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      insertRaw(db, { id: "s3", token_hash: "h3", currency: "USD" }),
    ).toThrow(/CHECK constraint failed/);
  });

  test("CHECK rejects unknown statuses", () => {
    const db = openDatabase();
    applyMigrations(db);
    expect(() => insertRaw(db, { status: "REFUNDED" })).toThrow(/CHECK constraint failed/);
    for (const status of ["PENDING", "PAID", "EXPIRED", "CANCELLED"]) {
      expect(() =>
        insertRaw(db, {
          id: `s-${status}`,
          token_hash: `h-${status}`,
          idempotency_key: `key-${status}`,
          status,
        }),
      ).not.toThrow();
    }
  });

  test("events reference their session (foreign key enforced when enabled)", () => {
    const db = openDatabase();
    applyMigrations(db);
    // SQLite requires an explicit PRAGMA for FK enforcement; verify the
    // constraint is declared so D1 (which enables FKs) enforces it.
    const ddl = db
      .query(
        "SELECT sql FROM sqlite_master WHERE name = 'checkout_session_events'",
      )
      .get() as { sql: string };
    expect(ddl.sql).toContain("REFERENCES checkout_sessions");
    db.run("PRAGMA foreign_keys = ON");
    insertRaw(db);
    expect(() =>
      db
        .query(
          `INSERT INTO checkout_session_events (id, session_id, event_type, actor, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("ev-1", "does-not-exist", "SESSION_CREATED", "bot", "{}", "2026-10-20T10:00:00.000Z"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("ISO timestamps sort and compare correctly for expiry range queries", () => {
    const { db } = migratedExecutor();
    insertRaw(db, {
      id: "a",
      token_hash: "ha",
      idempotency_key: "key-a",
      expires_at: "2026-10-20T10:30:00.000Z",
    });
    insertRaw(db, {
      id: "b",
      token_hash: "hb",
      idempotency_key: "key-b",
      expires_at: "2026-10-20T09:30:00.000Z",
    });
    const rows = db
      .query(
        `SELECT id FROM checkout_sessions
         WHERE order_id = ? AND status = 'PENDING' AND expires_at > ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .all("AVT-1", "2026-10-20T10:00:00.000Z") as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("a");
  });
});

describe("SqlSessionStore over real SQLite", () => {
  test("store raises IdempotencyConflict on duplicate (key, attempt)", async () => {
    const { executor } = migratedExecutor();
    const store = new SqlSessionStore(executor);
    const session = {
      id: "sess-1",
      orderId: "AVT-1",
      discordUserId: "123456789012345678",
      productId: "vp-1000",
      productName: "1000 VP",
      amountPaise: 99900,
      currency: "INR" as const,
      paymentProfileId: "primary",
      upi: { vpa: "merchant@upi", displayName: "Store" },
      status: "PENDING" as const,
      idempotencyKey: "AVT-1:checkout-session",
      attempt: 1,
      source: "discord_bot",
      providerTransactionRef: null,
      createdAt: new Date("2026-10-20T10:00:00Z"),
      updatedAt: new Date("2026-10-20T10:00:00Z"),
      expiresAt: new Date("2026-10-20T10:30:00Z"),
      paidAt: null,
    };
    await store.insertSession(session, "token-hash-1");
    await expect(
      store.insertSession({ ...session, id: "sess-2" }, "token-hash-2"),
    ).rejects.toThrow(IdempotencyConflict);

    // Round-trip: read by token hash returns the persisted values.
    const found = await store.findByTokenHash("token-hash-1");
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("AVT-1");
    expect(found!.amountPaise).toBe(99900);
    expect(found!.upi.vpa).toBe("merchant@upi");
    expect(found!.status).toBe("PENDING");
    expect(found!.expiresAt.toISOString()).toBe("2026-10-20T10:30:00.000Z");
  });

  test("guarded UPDATE reports misses through rowsAffected (optimistic concurrency)", async () => {
    const { executor } = migratedExecutor();
    const store = new SqlSessionStore(executor);
    const base = {
      id: "sess-1",
      orderId: "AVT-1",
      discordUserId: "123456789012345678",
      productId: "vp-1000",
      productName: "1000 VP",
      amountPaise: 99900,
      currency: "INR" as const,
      paymentProfileId: "primary",
      upi: { vpa: "merchant@upi", displayName: "Store" },
      status: "PENDING" as const,
      idempotencyKey: "AVT-1:checkout-session",
      attempt: 1,
      source: "discord_bot",
      providerTransactionRef: null,
      createdAt: new Date("2026-10-20T10:00:00Z"),
      updatedAt: new Date("2026-10-20T10:00:00Z"),
      expiresAt: new Date("2026-10-20T10:30:00Z"),
      paidAt: null,
    };
    await store.insertSession(base, "hash-a");

    const now = new Date("2026-10-20T10:05:00Z");
    expect(await store.updateStatus("sess-1", "PENDING", "EXPIRED", now)).toBe(true);
    // Second transition from PENDING must miss (row already EXPIRED).
    expect(await store.updateStatus("sess-1", "PENDING", "PAID", now, "txn")).toBe(false);
    const after = await store.findById("sess-1");
    expect(after!.status).toBe("EXPIRED");
    expect(after!.providerTransactionRef).toBeNull();
    expect(after!.paidAt).toBeNull();
  });

  test("SQL injection attempts in order_id are stored as literal values", async () => {
    const { executor } = migratedExecutor();
    const store = new SqlSessionStore(executor);
    const evil = "x'; DROP TABLE checkout_sessions; --";
    const session = {
      id: "sess-inj",
      orderId: evil,
      discordUserId: "123456789012345678",
      productId: "p",
      productName: "n",
      amountPaise: 100,
      currency: "INR" as const,
      paymentProfileId: "primary",
      upi: { vpa: "merchant@upi", displayName: "Store" },
      status: "PENDING" as const,
      idempotencyKey: "inj:checkout-session",
      attempt: 1,
      source: "discord_bot",
      providerTransactionRef: null,
      createdAt: new Date("2026-10-20T10:00:00Z"),
      updatedAt: new Date("2026-10-20T10:00:00Z"),
      expiresAt: new Date("2026-10-20T10:30:00Z"),
      paidAt: null,
    };
    await store.insertSession(session, "hash-inj");
    const found = await store.findActiveByOrderId(evil, new Date("2026-10-20T10:01:00Z"));
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe(evil); // stored verbatim, table intact
    const tables = (await executor.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
      [],
    )).map((t) => t.name);
    expect(tables).toContain("checkout_sessions");
  });
});
