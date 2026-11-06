/**
 * UPI payment payload construction.
 *
 * The payload is built exclusively from the *stored* session snapshot — never
 * from anything the customer sends — so the QR always matches the recipient and
 * amount fixed at session creation. Format is the standard UPI deep link
 * (upi://pay) accepted by every UPI app; no provider-specific payload is used.
 */

import type { CheckoutSession } from "./types";

/** Formats paise as a decimal rupee string with exactly 2 fractional digits. */
export function formatRupees(amountPaise: number): string {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new Error("invalid amount");
  }
  return (amountPaise / 100).toFixed(2);
}

/** Indian digit grouping: 12,34,567.89 */
export function formatInrDisplay(amountPaise: number): string {
  const rupees = formatRupees(amountPaise);
  const [whole, fraction] = rupees.split(".");
  const sign = whole!.startsWith("-") ? "-" : "";
  const digits = sign ? whole!.slice(1) : whole!;
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${sign}${grouped}.${fraction}`;
}

/**
 * Builds the upi://pay deep link for a session. This exact string is what the
 * page renders as a QR code, so the QR provably matches the stored session.
 */
export function buildUpiPayload(session: CheckoutSession): string {
  const params = new URLSearchParams();
  params.set("pa", session.upi.vpa);
  params.set("pn", session.upi.displayName);
  params.set("am", formatRupees(session.amountPaise));
  params.set("cu", session.currency);
  params.set("tn", `Aventas order ${session.orderId}`);
  // URLSearchParams encodes with '+', which some UPI apps mishandle; use %20.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}
