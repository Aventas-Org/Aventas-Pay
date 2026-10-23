/**
 * Server-to-server cancel-session handler (bot -> website).
 *
 * Cancellation is an authorized operation: it requires the same dedicated bot
 * secret as session creation and only ever applies to the session attached to
 * the supplied order. It is idempotent: cancelling an already-terminal session
 * returns the current state with 200 and performs no transition.
 */

import type { CheckoutSession, Clock, SessionStore } from "../domain/types";
import { canTransition } from "../domain/stateMachine";
import { deriveIdempotencyKey } from "../domain/idempotency";
import { ApiError, rateLimited, validationError } from "../domain/errors";
import { requireBotAuth } from "./auth";
import type { RateLimiter } from "../domain/rateLimit";
import type { CheckoutLogger } from "../domain/log";
import { dispatch, jsonResponse, parseJsonBody } from "./http";
import type { HandlerRequest, HandlerResponse } from "./http";
import { toPublicSessionView } from "./view";

export interface CancelSessionDeps {
  store: SessionStore;
  clock: Clock;
  limiter: RateLimiter;
  botApiSecret: string;
  websiteBaseUrl: string;
  /** Structured logger; defaults to silent. Wire consoleLogger in production. */
  logger?: CheckoutLogger;
}

export const CANCEL_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

export async function handleCancelSession(
  deps: CancelSessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return dispatch(() => cancelSessionImpl(deps, req), deps.logger);
}

async function cancelSessionImpl(
  deps: CancelSessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  await requireBotAuth(deps.botApiSecret, req, deps.logger);

  const limited = await deps.limiter.consume(
    `cancel:${req.clientIp}`,
    CANCEL_RATE_LIMIT.limit,
    CANCEL_RATE_LIMIT.windowSeconds,
    deps.clock.now(),
  );
  if (limited !== null) throw rateLimited(limited);

  const body = await parseJsonBody(req);
  const orderId =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).order_id
      : undefined;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(orderId)) {
    throw validationError(["order_id"]);
  }

  const now = deps.clock.now();
  // Latest session for this order, active or terminal, so a repeated cancel is
  // idempotent and returns the current state instead of a confusing 404.
  const latest = await deps.store.findLatestByIdempotencyKey(
    deriveIdempotencyKey(orderId),
  );
  const session =
    latest && latest.orderId === orderId
      ? latest
      : await deps.store.findActiveByOrderId(orderId, now);
  if (!session) {
    // Unknown order: generic not-found, no distinction leaked.
    throw new ApiError("NOT_FOUND", 404);
  }

  if (!canTransition(session.status, "CANCELLED")) {
    return jsonResponse(200, {
      ...toPublicSessionView(session),
      status: session.status,
    });
  }

  const applied = await deps.store.updateStatus(session.id, "PENDING", "CANCELLED", now);
  const current: CheckoutSession | null = applied
    ? { ...session, status: "CANCELLED", updatedAt: now }
    : await deps.store.findById(session.id);

  if (applied) {
    await deps.store.appendEvent({
      sessionId: session.id,
      eventType: "SESSION_CANCELLED",
      actor: "bot",
      detail: { order_id: orderId },
    });
  }

  return jsonResponse(200, {
    ...toPublicSessionView(current ?? session),
    status: current?.status ?? session.status,
  });
}

export { requireBotAuth };
