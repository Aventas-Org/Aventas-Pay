/**
 * SessionStore implementation over the SqlExecutor port.
 *
 * This is the production persistence adapter: every statement is a fixed
 * string with positional parameters (SQL-injection safe by construction), the
 * UNIQUE constraints declared in migrations/0001_checkout_sessions.sql are
 * surfaced as IdempotencyConflict, and the optimistic status transition is a
 * single guarded UPDATE so concurrent writers cannot clobber each other.
 *
 * Timestamps are stored as INTEGER epoch-milliseconds, matching the
 * Aventas-website convention (orders.placed_at, *.created_at, etc). The
 * migrations declare these columns as INTEGER; epoch numbers also sort and
 * compare correctly for the range/point queries used here.
 */

import {
  CheckoutSession,
  IdempotencyConflict,
  SessionEvent,
  SessionStatus,
  SessionStore,
} from "../domain/types";
import { ConstraintViolation, SqlExecutor, SqlValue } from "./sqlPort";

const INSERT_SESSION_SQL = `
INSERT INTO checkout_sessions (
  id, order_id, discord_user_id, product_id, product_name, amount_paise,
  currency, payment_profile_id, upi_vpa, upi_display_name, status,
  idempotency_key, attempt, token_hash, source, provider_transaction_ref,
  created_at, updated_at, expires_at, paid_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SESSION_COLUMNS = `
  id, order_id, discord_user_id, product_id, product_name, amount_paise,
  currency, payment_profile_id, upi_vpa, upi_display_name, status,
  idempotency_key, attempt, token_hash, source, provider_transaction_ref,
  created_at, updated_at, expires_at, paid_at
`;

interface SessionRow {
  id: string;
  order_id: string;
  discord_user_id: string;
  product_id: string;
  product_name: string;
  amount_paise: number;
  currency: string;
  payment_profile_id: string;
  upi_vpa: string;
  upi_display_name: string;
  status: string;
  idempotency_key: string;
  attempt: number;
  token_hash: string;
  source: string;
  provider_transaction_ref: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  paid_at: number | null;
}

export class SqlSessionStore implements SessionStore {
  constructor(private readonly db: SqlExecutor) {}

  async insertSession(session: CheckoutSession, tokenHash: string): Promise<void> {
    const params: SqlValue[] = [
      session.id,
      session.orderId,
      session.discordUserId,
      session.productId,
      session.productName,
      session.amountPaise,
      session.currency,
      session.paymentProfileId,
      session.upi.vpa,
      session.upi.displayName,
      session.status,
      session.idempotencyKey,
      session.attempt,
      tokenHash,
      session.source,
      session.providerTransactionRef,
      toDb(session.createdAt),
      toDb(session.updatedAt),
      toDb(session.expiresAt),
      session.paidAt ? toDb(session.paidAt) : null,
    ];
    try {
      await this.db.run(INSERT_SESSION_SQL, params);
    } catch (err) {
      const violation = err instanceof ConstraintViolation ? err : null;
      if (violation?.unique) throw new IdempotencyConflict();
      throw err;
    }
  }

  async findByTokenHash(tokenHash: string): Promise<CheckoutSession | null> {
    const row = await this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM checkout_sessions WHERE token_hash = ?`,
      [tokenHash],
    );
    return row ? fromDb(row) : null;
  }

  async findById(sessionId: string): Promise<CheckoutSession | null> {
    const row = await this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM checkout_sessions WHERE id = ?`,
      [sessionId],
    );
    return row ? fromDb(row) : null;
  }

  async findActiveByOrderId(orderId: string, now: Date): Promise<CheckoutSession | null> {
    // "Active" is evaluated in SQL: PENDING and strictly before expiry.
    const row = await this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM checkout_sessions
       WHERE order_id = ? AND status = 'PENDING' AND expires_at > ?
       ORDER BY attempt DESC LIMIT 1`,
      [orderId, toDb(now)],
    );
    return row ? fromDb(row) : null;
  }

  async findLatestByIdempotencyKey(key: string): Promise<CheckoutSession | null> {
    const row = await this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM checkout_sessions
       WHERE idempotency_key = ?
       ORDER BY attempt DESC LIMIT 1`,
      [key],
    );
    return row ? fromDb(row) : null;
  }

  async updateStatus(
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
    now: Date,
    providerTransactionRef?: string | null,
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      `UPDATE checkout_sessions
       SET status = ?,
           updated_at = ?,
           paid_at = CASE WHEN ? = 'PAID' THEN ? ELSE paid_at END,
           provider_transaction_ref = CASE WHEN ? = 'PAID' THEN ? ELSE provider_transaction_ref END
       WHERE id = ? AND status = ?`,
      [
        to,
        toDb(now),
        to,
        toDb(now),
        to,
        providerTransactionRef ?? null,
        sessionId,
        from,
      ],
    );
    // Optimistic guard: the WHERE clause pins the expected current status, so
    // a concurrent writer that moved the row first yields rowsAffected = 0.
    return rowsAffected > 0;
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    await this.db.run(
      `INSERT INTO checkout_session_events (id, session_id, event_type, actor, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        event.sessionId,
        event.eventType,
        event.actor,
        JSON.stringify(event.detail),
        toDb(new Date()),
      ],
    );
  }
}

/** Epoch-milliseconds, matching the website's INTEGER timestamp columns. */
function toDb(date: Date): number {
  return date.getTime();
}

function fromDb(row: SessionRow): CheckoutSession {
  return {
    id: row.id,
    orderId: row.order_id,
    discordUserId: row.discord_user_id,
    productId: row.product_id,
    productName: row.product_name,
    amountPaise: row.amount_paise,
    currency: "INR",
    paymentProfileId: row.payment_profile_id,
    upi: { vpa: row.upi_vpa, displayName: row.upi_display_name },
    status: row.status as SessionStatus,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    source: row.source,
    providerTransactionRef: row.provider_transaction_ref,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
    paidAt: row.paid_at === null || row.paid_at === undefined ? null : new Date(row.paid_at),
  };
}
