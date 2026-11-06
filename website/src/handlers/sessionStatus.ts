/**
 * Public checkout status handler (customer browser -> website).
 *
 * Security properties:
 *   - Lookup by bearer checkout token only; unknown/malformed tokens 404 generically.
 *   - Rate limited per client IP.
 *   - Response is the minimal projection required to render the page: no
 *     discord_user_id, no internal session id, no payment_profile_id, no
 *     idempotency key, no token hash, no provider references.
 *   - The UPI payload is rebuilt from the STORED session snapshot, so the QR the
 *     page renders always matches the recipient and amount fixed at creation.
 *   - An expired session reports EXPIRED; there is no public transition that can
 *     revive it, and no public request can ever produce PAID.
 */

import type { Clock, SessionStore } from "../domain/types";
import { notFound, rateLimited } from "../domain/errors";
import { hashCheckoutToken, looksLikeCheckoutToken } from "../domain/tokens";
import { effectiveStatus } from "../domain/stateMachine";
import type { RateLimiter } from "../domain/rateLimit";
import { nullLogger } from "../domain/log";
import type { CheckoutLogger } from "../domain/log";
import { dispatch, jsonResponse } from "./http";
import type { HandlerRequest, HandlerResponse } from "./http";
import { toPublicSessionView } from "./view";

export interface SessionStatusDeps {
  store: SessionStore;
  clock: Clock;
  limiter: RateLimiter;
  /** Structured logger; defaults to silent. Wire consoleLogger in production. */
  logger?: CheckoutLogger;
}

export const STATUS_RATE_LIMIT = { limit: 30, windowSeconds: 60 };

export async function handleSessionStatus(
  deps: SessionStatusDeps,
  req: HandlerRequest,
  checkoutToken: string,
): Promise<HandlerResponse> {
  return dispatch(() => sessionStatusImpl(deps, req, checkoutToken), deps.logger);
}

async function sessionStatusImpl(
  deps: SessionStatusDeps,
  req: HandlerRequest,
  checkoutToken: string,
): Promise<HandlerResponse> {
  const limited = await deps.limiter.consume(
    `status:${req.clientIp}`,
    STATUS_RATE_LIMIT.limit,
    STATUS_RATE_LIMIT.windowSeconds,
    deps.clock.now(),
  );
  const logger = deps.logger ?? nullLogger;

  if (limited !== null) {
    logger.log("status_rate_limited", { client_ip: req.clientIp, retry_after_seconds: limited });
    throw rateLimited(limited);
  }

  if (!looksLikeCheckoutToken(checkoutToken)) {
    logger.log("status_rejected", { reason: "malformed_token", client_ip: req.clientIp });
    throw notFound();
  }

  const tokenHash = await hashCheckoutToken(checkoutToken);
  const session = await deps.store.findByTokenHash(tokenHash);
  if (!session) {
    logger.log("status_rejected", { reason: "unknown_token", client_ip: req.clientIp });
    throw notFound();
  }

  const now = deps.clock.now();
  const status = effectiveStatus(session, now);

  // Best-effort persistence of the expiry transition for the audit trail. A
  // failure here must not break the read path: the effective status is already
  // EXPIRED from the reader's perspective and can never go back to PENDING.
  if (status === "EXPIRED" && session.status === "PENDING") {
    try {
      await deps.store.updateStatus(session.id, "PENDING", "EXPIRED", now);
      await deps.store.appendEvent({
        sessionId: session.id,
        eventType: "SESSION_EXPIRED",
        actor: "system",
        detail: { order_id: session.orderId },
      });
    } catch {
      // Audit write failed; the read response stays correct.
    }
  }

  return jsonResponse(200, {
    ...toPublicSessionView(session),
    status,
  });
}
