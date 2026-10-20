/**
 * Server-to-server payment-verification handler (bot -> website).
 *
 * This is the ONLY HTTP path that can mark a session PAID, and it is reachable
 * exclusively over the dedicated bot secret (constant-time verified). It is
 * designed to be called from the bot's EXISTING verification pipeline at the
 * moment that pipeline has already established payment:
 *   * staff approval by the configured verifier role, or
 *   * the bot's Slice payment-received email auto-verification (IMAP), which
 *     already dedupes one receipt (Slice Message-ID) to one order.
 *
 * It records what the trusted bot asserts; it does NOT verify money itself and
 * must never be called on a customer action, a redirect, a polling response or
 * an unreviewed screenshot. The provider transaction reference is REQUIRED so
 * every PAID state is attributable, and a partial unique index (migration
 * 0003) makes one reference unusable for a second order even if the caller
 * misbehaves.
 *
 * Semantics:
 *   * PENDING session  -> PAID (200), audit event PAYMENT_RECORDED.
 *   * already PAID with the SAME reference -> 200 idempotent replay.
 *   * already PAID with a DIFFERENT reference -> 409 CONFLICT.
 *   * expired session  -> 409 CONFLICT (late payments reconcile out-of-band;
 *     a dead session is never revived, matching the domain rules).
 *   * CANCELLED/unknown -> 409/404 respectively.
 */

import { Clock, SessionStore } from "../domain/types";
import { conflict, notFound, rateLimited, validationError } from "../domain/errors";
import { IllegalTransition, recordTrustedPayment } from "../domain/stateMachine";
import { deriveIdempotencyKey } from "../domain/idempotency";
import { CheckoutLogger, nullLogger } from "../domain/log";
import { RateLimiter } from "../domain/rateLimit";
import { ConstraintViolation } from "../adapters/sqlPort";
import { HandlerRequest, HandlerResponse, dispatch, jsonResponse, parseJsonBody } from "./http";
import { requireBotAuth } from "./auth";
import { toPublicSessionView } from "./view";

export interface VerifySessionDeps {
  store: SessionStore;
  clock: Clock;
  limiter: RateLimiter;
  botApiSecret: string;
  logger?: CheckoutLogger;
}

export const VERIFY_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

const ORDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PROVIDER_REF_RE = /^[A-Za-z0-9._:-]{4,64}$/;

export async function handleVerifySession(
  deps: VerifySessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return dispatch(() => verifySessionImpl(deps, req), deps.logger);
}

async function verifySessionImpl(
  deps: VerifySessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const logger = deps.logger ?? nullLogger;
  await requireBotAuth(deps.botApiSecret, req, logger);

  const limited = await deps.limiter.consume(
    `verify:${req.clientIp}`,
    VERIFY_RATE_LIMIT.limit,
    VERIFY_RATE_LIMIT.windowSeconds,
    deps.clock.now(),
  );
  if (limited !== null) {
    logger.log("verify_rate_limited", { client_ip: req.clientIp });
    throw rateLimited(limited);
  }

  const body = await parseJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError(["body"]);
  }
  const b = body as Record<string, unknown>;
  const invalid: string[] = [];
  if (typeof b.order_id !== "string" || !ORDER_ID_RE.test(b.order_id)) {
    invalid.push("order_id");
  }
  if (typeof b.provider_transaction_ref !== "string" || !PROVIDER_REF_RE.test(b.provider_transaction_ref)) {
    invalid.push("provider_transaction_ref");
  }
  if (invalid.length > 0) throw validationError(invalid);

  const orderId = b.order_id as string;
  const providerRef = b.provider_transaction_ref as string;
  const now = deps.clock.now();

  const session =
    (await deps.store.findActiveByOrderId(orderId, now)) ??
    (await deps.store.findLatestByIdempotencyKey(deriveIdempotencyKey(orderId)));
  if (!session || session.orderId !== orderId) {
    logger.log("verify_rejected", { reason: "unknown_order", order_id: orderId });
    throw notFound();
  }

  // Idempotent replay: already PAID with the same reference.
  if (session.status === "PAID") {
    if (session.providerTransactionRef === providerRef) {
      logger.log("verify_replayed", { order_id: orderId });
      return jsonResponse(200, { ...toPublicSessionView(session), status: "PAID" });
    }
    logger.log("verify_rejected", { reason: "reference_mismatch", order_id: orderId });
    throw conflict();
  }

  try {
    const updated = await recordTrustedPayment(
      deps.store,
      session.id,
      providerRef,
      deps.clock,
    );
    logger.log("verify_recorded", {
      order_id: orderId,
      provider_transaction_ref: providerRef,
      amount_paise: updated.amountPaise,
    });
    return jsonResponse(200, { ...toPublicSessionView(updated), status: "PAID" });
  } catch (err) {
    if (err instanceof IllegalTransition) {
      // Expired or otherwise terminal: never revive, reconcile out-of-band.
      logger.log("verify_rejected", { reason: "not_payable", order_id: orderId });
      throw conflict();
    }
    if (err instanceof ConstraintViolation && err.unique) {
      // Same provider reference already verified another order.
      logger.log("verify_rejected", { reason: "reference_already_used", order_id: orderId });
      throw conflict();
    }
    throw err;
  }
}
