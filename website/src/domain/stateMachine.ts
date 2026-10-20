/**
 * Session status state machine and expiry semantics.
 *
 * Stage 1 invariant: nothing reachable from a customer action can produce PAID.
 * The only transition to PAID goes through recordTrustedPayment(), which callers
 * must wire exclusively to a trusted verification integration in a later stage.
 */

import {
  CheckoutSession,
  Clock,
  SessionStatus,
  TERMINAL_STATUSES,
} from "./types";

export class IllegalTransition extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`illegal status transition ${from} -> ${to}`);
    this.name = "IllegalTransition";
  }
}

const ALLOWED: Record<SessionStatus, readonly SessionStatus[]> = {
  PENDING: ["PAID", "EXPIRED", "CANCELLED"],
  PAID: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** True while the session still awaits payment (PENDING and not yet expired). */
export function isActive(session: CheckoutSession, now: Date): boolean {
  return session.status === "PENDING" && now.getTime() < session.expiresAt.getTime();
}

/**
 * Effective status as a reader should see it. A PENDING session whose expiry has
 * passed is EXPIRED; that status can never be reversed, and no public request can
 * change it back. Callers persist the transition (best effort) for the audit trail.
 */
export function effectiveStatus(session: CheckoutSession, now: Date): SessionStatus {
  if (session.status === "PENDING" && now.getTime() >= session.expiresAt.getTime()) {
    return "EXPIRED";
  }
  return session.status;
}

export function isExpired(session: CheckoutSession, now: Date): boolean {
  return effectiveStatus(session, now) === "EXPIRED";
}

export interface TransitionResult {
  session: CheckoutSession;
  event: { from: SessionStatus; to: SessionStatus };
}

/**
 * Applies a transition to an in-memory session value, enforcing the state
 * machine. Expired PENDING sessions cannot move to PAID: late or disputed
 * payments are reconciled out-of-band via the audit trail and provider reference,
 * never by reviving a dead session.
 */
export function applyTransition(
  session: CheckoutSession,
  to: SessionStatus,
  now: Date,
  providerTransactionRef: string | null = null,
): TransitionResult {
  const from = session.status;
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  if (to === "PAID" && isExpired(session, now)) {
    throw new IllegalTransition(from, to);
  }
  const updated: CheckoutSession = {
    ...session,
    status: to,
    updatedAt: now,
    providerTransactionRef:
      to === "PAID" ? providerTransactionRef : session.providerTransactionRef,
    paidAt: to === "PAID" ? now : session.paidAt,
  };
  return { session: updated, event: { from, to } };
}

/**
 * The single trusted entry point that may mark a session PAID. Stage 1 does not
 * expose this over HTTP; a later stage wires it to the payment verification
 * integration. It requires a provider transaction reference so that every PAID
 * state is attributable to an external, auditable event.
 */
export async function recordTrustedPayment(
  store: {
    findById(id: string): Promise<CheckoutSession | null>;
    updateStatus(
      id: string,
      from: SessionStatus,
      to: SessionStatus,
      now: Date,
      providerTransactionRef?: string | null,
    ): Promise<boolean>;
    appendEvent(event: {
      sessionId: string;
      eventType: "PAYMENT_RECORDED" | "STATUS_CHANGED";
      actor: string;
      detail: Record<string, string | number | boolean | null>;
    }): Promise<void>;
  },
  sessionId: string,
  providerTransactionRef: string,
  clock: Clock,
): Promise<CheckoutSession> {
  if (!providerTransactionRef || providerTransactionRef.trim().length < 4) {
    throw new Error("provider transaction reference required");
  }
  const now = clock.now();
  const session = await store.findById(sessionId);
  if (!session) throw new Error("session not found");
  const { session: updated } = applyTransition(session, "PAID", now, providerTransactionRef);
  const applied = await store.updateStatus(
    sessionId,
    "PENDING",
    "PAID",
    now,
    providerTransactionRef,
  );
  if (!applied) {
    // Concurrent transition: surface current state rather than overwriting it.
    const current = await store.findById(sessionId);
    if (!current) throw new Error("session not found");
    return current;
  }
  await store.appendEvent({
    sessionId,
    eventType: "PAYMENT_RECORDED",
    actor: "trusted_verifier",
    detail: { provider_transaction_ref: providerTransactionRef },
  });
  return updated;
}

export function assertNotTerminal(status: SessionStatus): void {
  if (TERMINAL_STATUSES.has(status)) throw new IllegalTransition(status, "PENDING");
}
