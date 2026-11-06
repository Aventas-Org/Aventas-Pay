/**
 * Server-side validation of the authenticated bot create-session request.
 *
 * Trust boundary: the request body is trusted ONLY because it arrived over the
 * authenticated bot channel (dedicated secret, constant-time verified). Even so,
 * every field is validated here: malformed amounts, ids or recipients must be
 * rejected rather than persisted. Unauthenticated clients can never reach this
 * path, and no public endpoint accepts amounts, recipients or product details.
 */

export const MIN_AMOUNT_PAISE = 100; // 1 INR
export const MAX_AMOUNT_PAISE = 1_000_000_000; // 1 crore INR
export const MIN_TTL_SECONDS = 300;
export const MAX_TTL_SECONDS = 7200;
export const DEFAULT_TTL_SECONDS = 1800;

export interface CreateSessionRequest {
  orderId: string;
  discordUserId: string;
  productId: string;
  productName: string;
  amountPaise: number;
  currency: "INR";
  paymentProfileId: string;
  upiVpa: string;
  upiDisplayName: string;
  idempotencyKey: string;
  ttlSeconds: number;
}

const ORDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PROFILE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const SNOWFLAKE_RE = /^\d{15,20}$/;
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,160}$/;

/** Strips control characters and enforces a length bound on display text. */
function cleanDisplayText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length < 1 || cleaned.length > max) return null;
  return cleaned;
}

export type ValidationResult =
  | { ok: true; value: CreateSessionRequest }
  | { ok: false; invalidFields: string[] };

export function validateCreateSessionRequest(body: unknown): ValidationResult {
  const invalid: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, invalidFields: ["body"] };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.order_id !== "string" || !ORDER_ID_RE.test(b.order_id)) {
    invalid.push("order_id");
  }
  if (typeof b.discord_user_id !== "string" || !SNOWFLAKE_RE.test(b.discord_user_id)) {
    invalid.push("discord_user_id");
  }
  if (typeof b.product_id !== "string" || !PRODUCT_ID_RE.test(b.product_id)) {
    invalid.push("product_id");
  }
  const productName = cleanDisplayText(b.product_name, 120);
  if (productName === null) invalid.push("product_name");

  const amount = b.amount_paise;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < MIN_AMOUNT_PAISE ||
    amount > MAX_AMOUNT_PAISE
  ) {
    invalid.push("amount_paise");
  }
  if (b.currency !== "INR") invalid.push("currency");

  if (typeof b.payment_profile_id !== "string" || !PROFILE_ID_RE.test(b.payment_profile_id)) {
    invalid.push("payment_profile_id");
  }

  const upi = b.upi;
  let upiVpa: string | null = null;
  let upiDisplayName: string | null = null;
  if (typeof upi !== "object" || upi === null || Array.isArray(upi)) {
    invalid.push("upi");
  } else {
    const u = upi as Record<string, unknown>;
    if (typeof u.vpa !== "string" || !VPA_RE.test(u.vpa)) invalid.push("upi.vpa");
    else upiVpa = u.vpa;
    upiDisplayName = cleanDisplayText(u.display_name, 64);
    if (upiDisplayName === null) invalid.push("upi.display_name");
  }

  let idempotencyKey: string;
  if (b.idempotency_key === undefined || b.idempotency_key === null) {
    if (typeof b.order_id !== "string" || !ORDER_ID_RE.test(b.order_id)) {
      invalid.push("idempotency_key");
    }
    idempotencyKey = `${String(b.order_id)}:checkout-session`;
  } else if (typeof b.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(b.idempotency_key)) {
    invalid.push("idempotency_key");
    idempotencyKey = "";
  } else {
    idempotencyKey = b.idempotency_key;
  }

  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (b.ttl_seconds !== undefined && b.ttl_seconds !== null) {
    if (
      typeof b.ttl_seconds !== "number" ||
      !Number.isSafeInteger(b.ttl_seconds) ||
      b.ttl_seconds < MIN_TTL_SECONDS ||
      b.ttl_seconds > MAX_TTL_SECONDS
    ) {
      invalid.push("ttl_seconds");
    } else {
      ttlSeconds = b.ttl_seconds;
    }
  }

  if (invalid.length > 0) return { ok: false, invalidFields: invalid };
  return {
    ok: true,
    value: {
      orderId: b.order_id as string,
      discordUserId: b.discord_user_id as string,
      productId: b.product_id as string,
      productName: productName as string,
      amountPaise: amount as number,
      currency: "INR",
      paymentProfileId: b.payment_profile_id as string,
      upiVpa: upiVpa as string,
      upiDisplayName: upiDisplayName as string,
      idempotencyKey,
      ttlSeconds,
    },
  };
}
