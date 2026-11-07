/**
 * Read-only, untrusted payment-email evidence parser.
 *
 * Never use an email (including a claimed bank sender, DKIM/SPF-looking header,
 * amount or date) as merchant-bank settlement authority.
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
  | "NON_CREDIT_NOTIFICATION";

export interface UntrustedPaymentEvidence {
  readonly classification: "NEEDS_REVIEW";
  readonly paymentVerified: false;
  readonly canFulfill: false;
  /** Unverified rupee value, parsed exactly to integer paise if unambiguous. */
  readonly reportedAmountPaise: number | null;
  readonly warnings: readonly EvidenceWarning[];
}

const MAX_BODY = 16_384;
const MAX_SUBJECT = 512;
const MAX_FROM = 512;
const AMOUNT = /(?:₹|\bINR\b|\bRs\.?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?!\d|\.\d)/gi;

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
    // End tags may contain whitespace or other attributes (e.g. </script >,
    // </script foo="bar">). Discard unmatched raw-text blocks through EOF
    // instead of accidentally extracting fake payment amounts from them.
    // This is evidence extraction only, NEVER an HTML sanitizer for rendering.
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\b[^>]*>|$)/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\b[^>]*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/&amp;/gi, "&");
}


/**
 * Slice credit mail has TWO independent monetary values:
 * the transaction credit and the AVAILABLE BALANCE. Extracting all ₹ values
 * therefore rejects real credits or, worse, could attribute the balance.
 *
 * Only the exact synthetic template contract below is recognized, and only
 * for UNTRUSTED review evidence. The sender/subject/body may all be spoofed.
 */
const SLICE_SUBJECT = /^Received\s+₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+in your slice account\s*$/i;
const SLICE_CREDIT_BODY =
  /\bYou\s+have\s+received\s+₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+via\s+UPI\s+in\s+your\s+slice\s+bank\s+account\b/gi;

function parseSliceCredit(subject: string, body: string): {
  amountPaise: number | null;
  warning: EvidenceWarning | null;
} {
  if (/\bdebited\s+from\s+your\s+slice\s+account\b/i.test(subject)) {
    return { amountPaise: null, warning: "NON_CREDIT_NOTIFICATION" };
  }
  // An apparent Slice credit must NOT fall back to generic amount extraction
  // when a field is missing, misspelled, edited, or disagrees with the body.
  const a = SLICE_SUBJECT.exec(subject);
  if (!a) return { amountPaise: null, warning: "MISSING_AMOUNT" };
  const subjectPaise = parsePaise(a[1] ?? "");
  const anchors = [...body.matchAll(SLICE_CREDIT_BODY)];
  if (subjectPaise === null || anchors.length !== 1) {
    return {
      amountPaise: null,
      warning: anchors.length > 1 ? "CONFLICTING_AMOUNTS" : "MISSING_AMOUNT",
    };
  }
  const bodyPaise = parsePaise(anchors[0]![1] ?? "");
  if (bodyPaise === null || bodyPaise !== subjectPaise) {
    return { amountPaise: null, warning: "CONFLICTING_AMOUNTS" };
  }
  return { amountPaise: subjectPaise, warning: null };
}

export function parseUntrustedPaymentEmail(input: UntrustedPaymentEmail): UntrustedPaymentEvidence {
  const warnings: EvidenceWarning[] = ["UNTRUSTED_EMAIL_SOURCE"];
  // Runtime validation matters even for typed callers: mail is untrusted input.
  if (!input || typeof input.from !== "string" || typeof input.subject !== "string" ||
      typeof input.body !== "string" || input.from.length > MAX_FROM ||
      input.subject.length > MAX_SUBJECT || input.body.length > MAX_BODY) {
    return {
      classification: "NEEDS_REVIEW", paymentVerified: false, canFulfill: false,
      reportedAmountPaise: null,
      warnings: [...warnings, "INVALID_OR_OVERSIZED_INPUT"],
    };
  }

  const subject = readableSubject(input.subject);
  const body = readableBody(input.body);
  const looksLikeSliceCredit = /\bin your slice account\b/i.test(subject);
  const looksLikeSliceDebit = /\bdebited from your slice account\b/i.test(subject);
  if (looksLikeSliceCredit || looksLikeSliceDebit) {
    const credit = parseSliceCredit(subject, body);
    if (credit.warning) warnings.push(credit.warning);
    return {
      classification: "NEEDS_REVIEW",
      paymentVerified: false, canFulfill: false,
      reportedAmountPaise: credit.amountPaise,
      warnings,
    };
  }
  const text = subject + "\n" + body;
  const amounts = new Set<number>();
  for (const match of text.matchAll(AMOUNT)) {
    const value = parsePaise(match[1] ?? "");
    if (value !== null) amounts.add(value);
  }
  if (amounts.size === 0) warnings.push("MISSING_AMOUNT");
  if (amounts.size > 1) warnings.push("CONFLICTING_AMOUNTS");
  return {
    classification: "NEEDS_REVIEW",
    paymentVerified: false,
    canFulfill: false,
    reportedAmountPaise: amounts.size === 1 ? [...amounts][0]! : null,
    warnings,
  };
}
