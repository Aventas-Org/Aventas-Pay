/**
 * Idempotency key derivation and attempt calculation.
 *
 * The bot derives a deterministic key from (order_id, operation), so double
 * clicks and network retries always map to the same key. The server stores the
 * key with a monotonically increasing `attempt`: while an attempt is active
 * (PENDING and unexpired) a replay returns that session; once it has expired or
 * reached a terminal state, the next request legitimately opens attempt N+1.
 */

import { CheckoutSession } from "./types";
import { isActive } from "./stateMachine";

export const CHECKOUT_OPERATION = "checkout-session";

/**
 * Deterministic idempotency key for a checkout-session creation. The bot can
 * compute this locally without any server round trip, which makes duplicate
 * Discord button clicks collapse into one session.
 */
export function deriveIdempotencyKey(orderId: string, operation = CHECKOUT_OPERATION): string {
  return `${orderId}:${operation}`;
}

/**
 * Next attempt number to use when creating a session for `key`.
 * Returns 1 when the key has never been seen.
 */
export function nextAttempt(latest: CheckoutSession | null): number {
  return latest ? latest.attempt + 1 : 1;
}

/**
 * Replays (same key) should return an existing session while it is still active.
 * Expired or terminal sessions are never returned for reuse.
 */
export function reusableSession(
  latest: CheckoutSession | null,
  now: Date,
): CheckoutSession | null {
  if (!latest) return null;
  return isActive(latest, now) ? latest : null;
}
