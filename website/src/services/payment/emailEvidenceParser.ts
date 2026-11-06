/**
 * Read-only, untrusted payment-email evidence parser.
 *
 * Never use an email (including a claimed bank sender, DKIM/SPF-looking header,
 * transaction ID, amount or date) as merchant-bank settlement authority.
 * No network, database, order state transitions, or payment/fulfillment hooks.
 */
import { Buffer } from "node:buffer";

export interface UntrustedPaymentEmail {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly authenticationResults?: string;
}

export type EvidenceWarning =
  | "UNTRUSTED_EMAIL_SOURCE"
  | "INVALID_OR_OVERSIZED_INPUT"
  | "MISSING_AMOUNT"
  | "CONFLICTING_AMOUNTS"
  | "MISSING_REFERENCE"
  | "CONFLICTING_REFERENCES";

export interface UntrustedPaymentEvidence {
  readonly classification: "NEEDS_REVIEW";
  readonly paymentVerified: false;
  readonly canFulfill: false;
  /** Unverified rupee value, parsed exactly to integer paise if unambiguous. */
  readonly reportedAmountPaise: number | null;
  /** Unverified, explicitly labeled 12-digit UPI reference. */
  readonly reportedRrn: string | null;
  readonly warnings: readonly EvidenceWarning[];
}

const MAX_BODY = 16_384;
const MAX_SUBJECT = 512;
const MAX_FROM = 512;
const AMOUNT = /(?:₹|\bINR\b|\bRs\.?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?![\d.])/gi;
const RRN = /\b(?:RRN|UTR|UPI\s*Ref(?:erence)?(?:\s*(?:No|Number))?|Transaction\s*(?:ID|Ref(?:erence)?))\s*[:#.-]?\s*(\d{12})(?!\d)/gi;

function parsePaise(text: string): number | null {
  const [whole, fractional = ""] = text.split(".");
  if (!whole || !/^\d+(?:,\d+)*$/.test(whole)) return null;
  if (whole.includes(",") &&
      !/^\d{1,3}(?:,\d{3})+$/.test(whole) &&
      !/^\d{1,3}(?:,\d{2})+,\d{3}$/.test(whole)) return null;
  if (fractional.length > 2) return null;
  const integer = whole.replace(/,/g, "");
  try {
    const value = BigInt(integer) * 100n + BigInt(fractional.padEnd(2, "0"));
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  } catch {
    return null;
  }
}

function readableSubject(subject: string): string {
  // Decoding presentation text does not authenticate the email.
  return subject.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (original, encoding: string, content: string) => {
    try {
      if (encoding.toLowerCase() === "b") {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return original;
        return Buffer.from(content, "base64").toString("utf8");
      }
      const latin = content.replace(/_/g, " ").replace(/=([A-Fa-f0-9]{2})/g,
        (_: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(latin, "latin1").toString("utf8");
    } catch {
      return original;
    }
  });
}

function readableBody(body: string): string {
  // Strip only for evidence extraction; do not render the result as HTML.
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/&amp;/gi, "&");
}

export function parseUntrustedPaymentEmail(input: UntrustedPaymentEmail): UntrustedPaymentEvidence {
  const warnings: EvidenceWarning[] = ["UNTRUSTED_EMAIL_SOURCE"];
  // Runtime validation matters even for typed callers: mail is untrusted input.
  if (!input || typeof input.from !== "string" || typeof input.subject !== "string" ||
      typeof input.body !== "string" || input.from.length > MAX_FROM ||
      input.subject.length > MAX_SUBJECT || input.body.length > MAX_BODY) {
    return {
      classification: "NEEDS_REVIEW", paymentVerified: false, canFulfill: false,
      reportedAmountPaise: null, reportedRrn: null,
      warnings: [...warnings, "INVALID_OR_OVERSIZED_INPUT"],
    };
  }

  const text = readableSubject(input.subject) + "\n" + readableBody(input.body);
  const amounts = new Set<number>();
  const references = new Set<string>();
  for (const match of text.matchAll(AMOUNT)) {
    const value = parsePaise(match[1] ?? "");
    if (value !== null) amounts.add(value);
  }
  for (const match of text.matchAll(RRN)) {
    if (match[1]) references.add(match[1]);
  }
  if (amounts.size === 0) warnings.push("MISSING_AMOUNT");
  if (amounts.size > 1) warnings.push("CONFLICTING_AMOUNTS");
  if (references.size === 0) warnings.push("MISSING_REFERENCE");
  if (references.size > 1) warnings.push("CONFLICTING_REFERENCES");
  return {
    classification: "NEEDS_REVIEW",
    paymentVerified: false,
    canFulfill: false,
    reportedAmountPaise: amounts.size === 1 ? [...amounts][0]! : null,
    reportedRrn: references.size === 1 ? [...references][0]! : null,
    warnings,
  };
}
