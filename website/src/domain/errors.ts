/**
 * Generic error envelopes. Public and server-to-server responses must never
 * include stack traces, SQL, table names, discord ids, tokens or secrets.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Optional list of invalid field NAMES (never values). */
    fields?: string[];
    /** Seconds the client should wait before retrying (rate limiting). */
    retryAfterSeconds?: number;
  };
}

const GENERIC_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "Authentication failed.",
  VALIDATION_ERROR: "Request could not be processed.",
  NOT_FOUND: "Checkout session not found.",
  CONFLICT: "Checkout session is not in a payable state.",
  PAYLOAD_TOO_LARGE: "Request payload too large.",
  RATE_LIMITED: "Too many requests. Please retry later.",
  INTERNAL_ERROR: "An unexpected error occurred.",
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(code: ErrorCode, status: number, fields?: string[], retryAfterSeconds?: number) {
    super(GENERIC_MESSAGES[code]);
    this.name = "ApiError";
    this.status = status;
    const error: ApiErrorBody["error"] = { code, message: GENERIC_MESSAGES[code] };
    if (fields && fields.length > 0) error.fields = fields;
    if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
    this.body = { error };
  }
}

export const unauthorized = () => new ApiError("UNAUTHORIZED", 401);
export const conflict = () => new ApiError("CONFLICT", 409);
export const validationError = (fields: string[]) => new ApiError("VALIDATION_ERROR", 400, fields);
export const notFound = () => new ApiError("NOT_FOUND", 404);
export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError("RATE_LIMITED", 429, undefined, retryAfterSeconds);
export const internalError = () => new ApiError("INTERNAL_ERROR", 500);

export function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
