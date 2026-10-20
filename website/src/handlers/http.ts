/**
 * Small transport-agnostic HTTP helpers so handlers can be unit-tested without a
 * runtime-specific Request/Response shim. On transplant, the Worker router in
 * functions/api/[[route]].ts maps its incoming Request onto these inputs.
 */

import { ApiError, internalError, securityHeaders } from "../domain/errors";
import type { CheckoutLogger } from "../domain/log";

export interface HandlerRequest {
  method: string;
  /** Path relative to the API mount, e.g. "/payments/checkout-sessions/abc". */
  path: string;
  /** Parsed Authorization header value, if present. */
  authorization: string | null;
  /** Best-effort client IP for rate limiting. */
  clientIp: string;
  /** Raw request body text, if any. */
  bodyText: string | null;
}

export interface HandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function jsonResponse(status: number, payload: unknown): HandlerResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders() },
    body: JSON.stringify(payload),
  };
}

export function errorResponse(err: unknown, logger?: CheckoutLogger): HandlerResponse {
  if (err instanceof ApiError) return jsonResponse(err.status, err.body);
  // Unexpected failure: log it server-side (message + name only, no bodies or
  // secrets), return a generic envelope. Never leak internals to the client.
  logger?.log("internal_error", {
    error_name: err instanceof Error ? err.name : typeof err,
    error_message: err instanceof Error ? err.message : "unknown",
  });
  const fallback = internalError();
  return jsonResponse(fallback.status, fallback.body);
}

/**
 * Wraps a handler so it always returns a response: ApiError maps to its own
 * status, anything unexpected becomes a generic 500 with no internal details.
 * The Worker router and the tests both call handlers through this wrapper.
 */
export async function dispatch(
  handler: () => Promise<HandlerResponse>,
  logger?: CheckoutLogger,
): Promise<HandlerResponse> {
  try {
    return await handler();
  } catch (err) {
    return errorResponse(err, logger);
  }
}

/**
 * Maximum accepted request body. The largest legal create-session payload is
 * well under 1 KB; 4 KB leaves headroom while bounding parse cost and memory
 * per request in a multi-tenant isolate.
 */
export const MAX_BODY_BYTES = 4096;

export async function parseJsonBody(
  req: HandlerRequest,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  if (!req.bodyText) throw new ApiError("VALIDATION_ERROR", 400, ["body"]);
  // Byte length, not character length: a multi-byte payload must not sneak
  // past. TextEncoder is available in Workers, Bun and Node alike (Buffer is
  // NOT available in Workers).
  if (new TextEncoder().encode(req.bodyText).length > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", 413, ["body"]);
  }
  try {
    return JSON.parse(req.bodyText);
  } catch {
    throw new ApiError("VALIDATION_ERROR", 400, ["body"]);
  }
}
