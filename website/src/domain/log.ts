/**
 * Structured, redaction-guarded logging for the checkout API.
 *
 * Policy (enforced by redact() and covered by tests):
 *   - Never log: checkout tokens, token hashes, API secrets, Authorization
 *     headers, UPI VPAs, full request/response bodies.
 *   - Never log: Discord user IDs. Correlation uses the order_id, which staff
 *     already use operationally.
 *   - Always log: event name, outcome, HTTP status, latency, attempt counts.
 *
 * Log lines are single-line JSON so they grep cleanly in Workers Logs / wrangler
 * tail. The logger is injected via handler deps so tests can capture output.
 */

export type LogFields = Record<string, string | number | boolean | null>;

export interface CheckoutLogger {
  log(event: string, fields: LogFields): void;
}

/** Key names whose values are always masked, regardless of content. */
const SECRET_KEYS = new Set([
  "token",
  "checkout_token",
  "token_hash",
  "secret",
  "api_secret",
  "authorization",
  "upi_vpa",
  "vpa",
  "discord_user_id",
  "discorduserid",
]);

/** Long credential-like strings get masked even under innocent key names. */
const TOKEN_LIKE = /[A-Za-z0-9_-]{40,}/;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower)) {
      out[key] = "[REDACTED]";
    } else if (typeof value === "string" && TOKEN_LIKE.test(value)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Default logger: one JSON line per event on stdout. */
export const consoleLogger: CheckoutLogger = {
  log(event, fields) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event, ...redact(fields) }));
  },
};

/** No-op logger used by default so handlers stay silent unless wired. */
export const nullLogger: CheckoutLogger = {
  log() {
    /* intentionally silent */
  },
};

/** Test helper: captures events for assertions. */
export function capturingLogger(): CheckoutLogger & {
  events: Array<{ event: string; fields: LogFields }>;
} {
  const events: Array<{ event: string; fields: LogFields }> = [];
  return {
    events,
    log(event, fields) {
      events.push({ event, fields: redact(fields) });
    },
  };
}
