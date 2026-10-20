/**
 * Aventas Stage 1 — checkout session domain types.
 *
 * Statuses follow the names mandated by the Stage 1 brief. If the Aventas-website
 * repository later reveals a compatible existing state model, map as follows:
 *   PENDING   ~ awaiting_payment / unpaid
 *   PAID      ~ paid / captured (trusted verification only)
 *   EXPIRED   ~ expired / abandoned
 *   CANCELLED ~ cancelled / voided
 */

export type SessionStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

/** Statuses from which no further transition is allowed. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "PAID",
  "EXPIRED",
  "CANCELLED",
]);

export interface UpiSnapshot {
  /** Payee VPA, e.g. "merchant@upi". Public. */
  readonly vpa: string;
  /** Human-readable payee name shown next to the QR. Public. */
  readonly displayName: string;
}

/** A checkout session as persisted. Never expose this shape directly to the public. */
export interface CheckoutSession {
  readonly id: string;
  readonly orderId: string;
  /** PRIVATE server-side field. Must never appear in any public response. */
  readonly discordUserId: string;
  readonly productId: string;
  readonly productName: string;
  /** Authoritative amount in integer paise (1 INR = 100 paise). */
  readonly amountPaise: number;
  readonly currency: "INR";
  /** Identifier of the payment profile chosen by the trusted bot integration. */
  readonly paymentProfileId: string;
  /** Immutable snapshot of the selected recipient, fixed for the session lifetime. */
  readonly upi: UpiSnapshot;
  readonly status: SessionStatus;
  readonly idempotencyKey: string;
  readonly attempt: number;
  /** Provenance of the order facts. Stage 1: authenticated bot integration. */
  readonly source: string;
  readonly providerTransactionRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly paidAt: Date | null;
}

export interface SessionEvent {
  readonly sessionId: string;
  readonly eventType:
    | "SESSION_CREATED"
    | "STATUS_CHANGED"
    | "SESSION_EXPIRED"
    | "SESSION_CANCELLED"
    | "PAYMENT_RECORDED";
  /** Who caused the event: "bot" | "system" | "trusted_verifier". */
  readonly actor: string;
  /** Non-sensitive JSON detail only (no tokens, no discord ids, no secrets). */
  readonly detail: Record<string, string | number | boolean | null>;
}

/** Persistence port. D1 adapter implements this; tests use an in-memory store. */
export interface SessionStore {  /**
   * Inserts a new session row with its hashed public token. MUST enforce
   * UNIQUE(idempotency_key, attempt) and UNIQUE(token_hash); implementations
   * throw IdempotencyConflict when a constraint rejects the row.
   */
  insertSession(session: CheckoutSession, tokenHash: string): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<CheckoutSession | null>;
  findById(sessionId: string): Promise<CheckoutSession | null>;
  /** Most recent active (PENDING and unexpired) session for an order, if any. */
  findActiveByOrderId(orderId: string, now: Date): Promise<CheckoutSession | null>;
  /** Highest attempt recorded for an idempotency key (any status), if any. */
  findLatestByIdempotencyKey(key: string): Promise<CheckoutSession | null>;
  /**
   * Optimistic status transition: updates only when the current status matches
   * `from`. Returns false when the row was already transitioned concurrently.
   */
  updateStatus(
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
    now: Date,
    providerTransactionRef?: string | null,
  ): Promise<boolean>;
  appendEvent(event: SessionEvent): Promise<void>;
}

/** Thrown by SessionStore.insertSession when UNIQUE(idempotency_key, attempt) rejects. */
export class IdempotencyConflict extends Error {
  constructor() {
    super("idempotency conflict");
    this.name = "IdempotencyConflict";
  }
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
