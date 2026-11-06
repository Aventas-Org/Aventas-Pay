/**
 * Response projections of a session. Two distinct shapes exist on purpose:
 *
 *  1. PublicSessionView — the ONLY shape a customer-facing response may contain.
 *     It structurally omits discord_user_id, internal session id, token hash,
 *     idempotency key, attempt, payment profile id, source and provider refs.
 *
 *  2. BotCreateResponse — returned ONLY over the authenticated bot channel when
 *     a session is created or replayed. Adds the checkout token (bearer
 *     capability) and the ready-to-present checkout URL. Never logged, never
 *     returned from any public endpoint.
 */

import type { CheckoutSession } from "../domain/types";
import { buildUpiPayload, formatRupees } from "../domain/upi";

export interface PublicSessionView {
  order_ref: string;
  product: { name: string };
  amount_paise: number;
  amount_display: string;
  currency: "INR";
  upi: { vpa: string; display_name: string };
  qr_payload: string;
  expires_at: string;
}

export interface BotCreateResponse extends PublicSessionView {
  session_status: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  checkout_token: string;
  checkout_url: string;
  /** True when an existing active session was reused instead of creating a new one. */
  reused: boolean;
}

export function buildCheckoutUrl(websiteBaseUrl: string, checkoutToken: string): string {
  return `${websiteBaseUrl.replace(/\/+$/, "")}/checkout/${checkoutToken}`;
}

export function toPublicSessionView(session: CheckoutSession): PublicSessionView {
  return {
    order_ref: session.orderId,
    product: { name: session.productName },
    amount_paise: session.amountPaise,
    amount_display: formatRupees(session.amountPaise),
    currency: session.currency,
    upi: { vpa: session.upi.vpa, display_name: session.upi.displayName },
    qr_payload: buildUpiPayload(session),
    expires_at: session.expiresAt.toISOString(),
  };
}

export function toBotCreateResponse(
  session: CheckoutSession,
  checkoutToken: string,
  websiteBaseUrl: string,
  reused: boolean,
): BotCreateResponse {
  return {
    ...toPublicSessionView(session),
    session_status: session.status,
    checkout_token: checkoutToken,
    checkout_url: buildCheckoutUrl(websiteBaseUrl, checkoutToken),
    reused,
  };
}
