/**
 * Server-to-server create-checkout-session handler (bot -> website).
 *
 * Pipeline:
 *   1. Bearer secret, constant-time verified (dedicated payment integration secret).
 *   2. JSON parse + full field validation.
 *   3. Dedupe: an active session for the same order (or same idempotency key)
 *      is returned as-is; the checkout token is re-derived deterministically, so
 *      a retried request yields the identical checkout URL (HTTP 200).
 *   4. Otherwise a new session row is inserted under UNIQUE(idempotency_key, attempt);
 *      a concurrent-insert conflict is resolved by re-reading and returning the winner.
 *
 * The authoritative amount and recipient arrive over this authenticated channel
 * only (Stage 1 trust contract; see TRUST_BOUNDARY doc). No public endpoint
 * accepts amounts or recipients.
 */

import {
  CheckoutSession,
  Clock,
  IdempotencyConflict,
  SessionStore,
  systemClock,
} from "../domain/types";
import {
  ApiError,
  notFound,
  rateLimited,
  unauthorized,
  validationError,
} from "../domain/errors";
import { deriveCheckoutToken, hashCheckoutToken, constantTimeEqual } from "../domain/tokens";
import { validateCreateSessionRequest } from "../domain/validation";
import { deriveIdempotencyKey, nextAttempt, reusableSession } from "../domain/idempotency";
import { effectiveStatus } from "../domain/stateMachine";
import { RateLimiter } from "../domain/rateLimit";
import { CheckoutLogger, nullLogger } from "../domain/log";
import { HandlerRequest, HandlerResponse, dispatch, jsonResponse, parseJsonBody } from "./http";
import { toBotCreateResponse } from "./view";

export interface CreateSessionDeps {
  store: SessionStore;
  clock: Clock;
  limiter: RateLimiter;
  /** Dedicated payment integration secret (bot -> website). */
  botApiSecret: string;
  /** Secret used to derive checkout tokens. */
  tokenSecret: string;
  /** Public base URL of the Aventas website, e.g. "https://avantas.example". */
  websiteBaseUrl: string;
  /** Structured logger; defaults to silent. Wire consoleLogger in production. */
  logger?: CheckoutLogger;
}

export const CREATE_RATE_LIMIT = { limit: 120, windowSeconds: 60 };

export async function handleCreateSession(
  deps: CreateSessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return dispatch(() => createSessionImpl(deps, req), deps.logger);
}

async function createSessionImpl(
  deps: CreateSessionDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  const logger = deps.logger ?? nullLogger;
  const startedAt = systemClock.now().getTime();

  // 1. Auth: dedicated secret, constant-time comparison of SHA-256 digests.
  const expected = req.authorization ?? "";
  const scheme = expected.slice(0, 7).toLowerCase();
  const provided = scheme === "bearer " ? expected.slice(7) : "";
  if (
    provided.length === 0 ||
    deps.botApiSecret.length === 0 ||
    !(await constantTimeEqual(provided, deps.botApiSecret))
  ) {
    logger.log("create_rejected", { reason: "unauthorized", client_ip: req.clientIp });
    throw unauthorized();
  }

  // 2. Light rate limit on the server-to-server channel (abuse containment).
  const limited = await deps.limiter.consume(
    `create:${req.clientIp}`,
    CREATE_RATE_LIMIT.limit,
    CREATE_RATE_LIMIT.windowSeconds,
    deps.clock.now(),
  );
  if (limited !== null) {
    logger.log("create_rate_limited", { client_ip: req.clientIp, retry_after_seconds: limited });
    throw rateLimited(limited);
  }

  // 3. Validate.
  const body = await parseJsonBody(req);
  const validated = validateCreateSessionRequest(body);
  if (!validated.ok) {
    logger.log("create_rejected", {
      reason: "validation",
      invalid_field_count: validated.invalidFields.length,
    });
    throw validationError(validated.invalidFields);
  }
  const input = validated.value;
  const now = deps.clock.now();

  // 4. Dedupe by order: an active session is reused, never duplicated.
  const activeForOrder = await deps.store.findActiveByOrderId(input.orderId, now);
  if (activeForOrder) {
    logger.log("session_reused", {
      order_id: input.orderId,
      reason: "active_session_exists",
      http_status: 200,
    });
    return respondExisting(deps, activeForOrder, 200, true);
  }

  // 5. Dedupe by idempotency key: replay returns the in-flight/active attempt.
  const key = input.idempotencyKey || deriveIdempotencyKey(input.orderId);
  const latestForKey = await deps.store.findLatestByIdempotencyKey(key);
  const reusable = reusableSession(latestForKey, now);
  if (reusable) return respondExisting(deps, reusable, 200, true);

  // 6. Create the next attempt.
  const sessionId = crypto.randomUUID();
  const token = await deriveCheckoutToken(deps.tokenSecret, sessionId);
  const tokenHash = await hashCheckoutToken(token);
  const session: CheckoutSession = {
    id: sessionId,
    orderId: input.orderId,
    discordUserId: input.discordUserId,
    productId: input.productId,
    productName: input.productName,
    amountPaise: input.amountPaise,
    currency: "INR",
    paymentProfileId: input.paymentProfileId,
    upi: { vpa: input.upiVpa, displayName: input.upiDisplayName },
    status: "PENDING",
    idempotencyKey: key,
    attempt: nextAttempt(latestForKey),
    source: "discord_bot",
    providerTransactionRef: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    paidAt: null,
  };

  try {
    await deps.store.insertSession(session, tokenHash);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      // A concurrent request won the insert: return its active session.
      const winner = await deps.store.findLatestByIdempotencyKey(key);
      const activeWinner = reusableSession(winner, now);
      if (activeWinner) return respondExisting(deps, activeWinner, 200, true);
      throw notFound();
    }
    throw err;
  }

  await deps.store.appendEvent({
    sessionId,
    eventType: "SESSION_CREATED",
    actor: "bot",
    detail: {
      order_id: input.orderId,
      amount_paise: input.amountPaise,
      payment_profile_id: input.paymentProfileId,
      attempt: session.attempt,
    },
  });

  logger.log("session_created", {
    order_id: input.orderId,
    amount_paise: input.amountPaise,
    payment_profile_id: input.paymentProfileId,
    attempt: session.attempt,
    http_status: 201,
    latency_ms: systemClock.now().getTime() - startedAt,
  });

  return respondExisting(deps, session, 201, false);
}

async function respondExisting(
  deps: CreateSessionDeps,
  session: CheckoutSession,
  status: number,
  reused: boolean,
): Promise<HandlerResponse> {
  // Deterministic derivation: a replayed request re-derives the identical token
  // for the same session, so the bot always receives the same checkout URL.
  const token = await deriveCheckoutToken(deps.tokenSecret, session.id);
  // Expired sessions are never returned as active by the dedupe paths above.
  const viewSession =
    effectiveStatus(session, deps.clock.now()) === "PENDING"
      ? session
      : { ...session, status: effectiveStatus(session, deps.clock.now()) } as CheckoutSession;
  return jsonResponse(
    status,
    toBotCreateResponse(viewSession, token, deps.websiteBaseUrl, reused),
  );
}
