/**
 * In-memory SessionStore used by the test suite. It enforces the same
 * constraints the D1 schema enforces (UNIQUE(idempotency_key, attempt) and
 * UNIQUE(token_hash)) and throws IdempotencyConflict exactly like the D1
 * adapter must, so handler behaviour under concurrency matches production.
 */

import {
  CheckoutSession,
  IdempotencyConflict,
  SessionEvent,
  SessionStatus,
  SessionStore,
} from "../../src/domain/types";

export class InMemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, CheckoutSession>();
  readonly tokenHashes = new Map<string, string>();
  readonly events: SessionEvent[] = [];
  /** Simulates a database failure for the next write, if set. */
  failNextWrite: Error | null = null;

  async insertSession(session: CheckoutSession, tokenHash: string): Promise<void> {
    this.maybeFail();
    for (const existing of this.sessions.values()) {
      if (
        existing.idempotencyKey === session.idempotencyKey &&
        existing.attempt === session.attempt
      ) {
        throw new IdempotencyConflict();
      }
    }
    for (const existingHash of this.tokenHashes.values()) {
      if (existingHash === tokenHash) throw new IdempotencyConflict();
    }
    this.sessions.set(session.id, session);
    this.tokenHashes.set(session.id, tokenHash);
  }

  async findByTokenHash(tokenHash: string): Promise<CheckoutSession | null> {
    for (const [id, hash] of this.tokenHashes) {
      if (hash === tokenHash) return this.sessions.get(id) ?? null;
    }
    return null;
  }

  async findById(sessionId: string): Promise<CheckoutSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async findActiveByOrderId(orderId: string, now: Date): Promise<CheckoutSession | null> {
    const matches = [...this.sessions.values()].filter(
      (s) =>
        s.orderId === orderId &&
        s.status === "PENDING" &&
        now.getTime() < s.expiresAt.getTime(),
    );
    return matches.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
  }

  async findLatestByIdempotencyKey(key: string): Promise<CheckoutSession | null> {
    const matches = [...this.sessions.values()].filter((s) => s.idempotencyKey === key);
    return matches.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
  }

  async updateStatus(
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
    now: Date,
    providerTransactionRef?: string | null,
  ): Promise<boolean> {
    this.maybeFail();
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== from) return false;
    this.sessions.set(sessionId, {
      ...session,
      status: to,
      updatedAt: now,
      paidAt: to === "PAID" ? now : session.paidAt,
      providerTransactionRef:
        to === "PAID" ? (providerTransactionRef ?? null) : session.providerTransactionRef,
    });
    return true;
  }

  async appendEvent(event: SessionEvent): Promise<void> {
    this.maybeFail();
    this.events.push(event);
  }

  private maybeFail(): void {
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
  }
}
