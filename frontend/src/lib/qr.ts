/**
 * UPI QR helpers for the checkout page.
 *
 * The page renders the qr_payload the SERVER stored for the session. It never
 * builds a payload from values the browser controls, so the QR always matches
 * the recipient and amount fixed at session creation. `verifyQrMatchesSession`
 * exists so the page (and tests) can assert that invariant explicitly.
 */

export interface PublicSessionView {
  order_ref: string;
  product: { name: string };
  amount_paise: number;
  amount_display: string;
  currency: "INR";
  upi: { vpa: string; display_name: string };
  qr_payload: string;
  expires_at: string;
  status?: string;
}

/** Amount in paise -> "1234.56" (the format UPI apps expect in `am`). */
export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

/**
 * Independent re-derivation of the expected payload from the session fields,
 * used to verify the server-provided qr_payload before rendering.
 */
export function expectedQrPayload(session: PublicSessionView): string {
  const params = new URLSearchParams();
  params.set("pa", session.upi.vpa);
  params.set("pn", session.upi.display_name);
  params.set("am", paiseToRupees(session.amount_paise));
  params.set("cu", session.currency);
  params.set("tn", `Aventas order ${session.order_ref}`);
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/** True when the server payload provably encodes this session's stored details. */
export function verifyQrMatchesSession(session: PublicSessionView): boolean {
  if (typeof session.qr_payload !== "string" || session.qr_payload === "") return false;
  // Exact match against the independently re-derived payload.
  if (session.qr_payload !== expectedQrPayload(session)) return false;
  // Belt-and-braces: the payee and amount must literally appear in the payload.
  const encodedVpa = session.upi.vpa.replace(/@/g, "%40");
  return (
    session.qr_payload.includes(`pa=${encodedVpa}`) &&
    session.qr_payload.includes(`am=${paiseToRupees(session.amount_paise)}`)
  );
}

/** Formats paise for display in the Indian grouping, e.g. 123456789 -> ₹12,34,567.89 */
export function formatInr(paise: number): string {
  const rupees = paiseToRupees(paise);
  const [whole, fraction] = rupees.split(".");
  const digits = whole!;
  // Indian grouping: last three digits, then pairs from the right.
  if (digits.length <= 3) return `₹${digits}.${fraction}`;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) pairs.unshift(rest);
  return `₹${pairs.join(",")},${last3}.${fraction}`;
}
