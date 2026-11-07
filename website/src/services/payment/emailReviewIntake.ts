/**
 * Offline, pure, amount-only inbox evidence intake for staff reconciliation.
 *
 * An authenticated mailbox connection can establish which mailbox was read,
 * not whether a merchant received a bank credit. No Gmail/IMAP access, DB
 * writes, staff verification, trusted-verify call or order fulfillment here.
 *
 * NEVER connect this return value to the PAID state machine.
 */
import { createHash } from "node:crypto";
import {
  parseUntrustedPaymentEmail,
  type UntrustedPaymentEmail,
} from "./emailEvidenceParser";
import {
  correlateUntrustedEmailAmount,
  correlateUntrustedEmailAmountWithReceivedTime,
  type AmountOnlyReviewResult,
  type ReviewOrderSnapshot,
} from "./amountOnlyReview";

/** Trusted integration must source these from its authorized mailbox API. */
export interface InboxEvidenceEnvelope {
  readonly mailboxConnectionId: string;
  /** Provider-assigned mailbox API message ID; NOT the email Message-ID header. */
  readonly mailboxMessageId: string;
  readonly email: UntrustedPaymentEmail;
  /** Gmail message.internalDate in UTC epoch ms, never the untrusted Date header. */
  readonly gmailReceivedAtMs?: number;
}

/** Restricted storage representation: no raw message, header or UTR. */
export interface EmailReviewReceipt {
  /** SHA-256 of the mailbox-connection/message-ID tuple. */
  readonly messageKeyDigest: string;
  /** SHA-256 of the email evidence bytes for changed-message conflict review. */
  readonly contentDigest: string;
}

export type InboxIntakeState =
  | "INVALID_ENVELOPE"
  | "INVALID_EVIDENCE"
  | "DUPLICATE_MESSAGE"
  | "MESSAGE_ID_CONTENT_CONFLICT"
  | "NEW_REVIEW_EVIDENCE";

export interface InboxIntakeResult {
  readonly classification: "NEEDS_REVIEW";
  readonly paymentVerified: false;
  readonly canFulfill: false;
  readonly state: InboxIntakeState;
  readonly match: AmountOnlyReviewResult["match"] | null;
  readonly candidateOrderId: string | null;
  readonly receipt: EmailReviewReceipt | null;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function safeProviderMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function result(
  state: InboxIntakeState,
  match: AmountOnlyReviewResult["match"] | null = null,
  candidateOrderId: string | null = null,
  receipt: EmailReviewReceipt | null = null,
): InboxIntakeResult {
  return {
    classification: "NEEDS_REVIEW",
    paymentVerified: false,
    canFulfill: false,
    state,
    match,
    candidateOrderId,
    receipt,
  };
}

/**
 * Stages untrusted email for review, with repeat-message screening.
 *
 * priorReceipts MUST come from an independently protected, atomically
 * unique review-only receipt store. This pure function DOES NOT enforce DB
 * uniqueness, authenticate the sender or verify a bank settlement.
 */
export function stageInboxEmailForReview(
  envelope: InboxEvidenceEnvelope,
  priorReceipts: readonly EmailReviewReceipt[],
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
  requireGmailReceivedTime = false,
): InboxIntakeResult {
  if (!envelope || !safeConnectionId(envelope.mailboxConnectionId) ||
      !safeProviderMessageId(envelope.mailboxMessageId) ||
      !Array.isArray(priorReceipts) || !Array.isArray(ordersInReconciliationWindow) ||
      !priorReceipts.every((entry) => entry &&
        isDigest(entry.messageKeyDigest) && isDigest(entry.contentDigest))) {
    return result("INVALID_ENVELOPE");
  }

  const evidence = parseUntrustedPaymentEmail(envelope.email);
  if (evidence.warnings.includes("INVALID_OR_OVERSIZED_INPUT")) {
    return result("INVALID_EVIDENCE");
  }

  // Delimit each field unambiguously. Do not return raw email content or IDs.
  const messageKeyDigest = hash(JSON.stringify([
    envelope.mailboxConnectionId, envelope.mailboxMessageId,
  ]));
  const contentDigest = hash(JSON.stringify([
    envelope.email.from, envelope.email.subject, envelope.email.body,
    envelope.email.authenticationResults ?? null,
    envelope.gmailReceivedAtMs ?? null,
  ]));
  const receipt: EmailReviewReceipt = { messageKeyDigest, contentDigest };

  const previous = priorReceipts.filter((entry) => entry.messageKeyDigest === messageKeyDigest);
  if (previous.length > 1 ||
      previous.some((entry) => entry.contentDigest !== contentDigest)) {
    return result("MESSAGE_ID_CONTENT_CONFLICT");
  }
  if (previous.length === 1) {
    return result("DUPLICATE_MESSAGE");
  }

  const match = requireGmailReceivedTime
    ? correlateUntrustedEmailAmountWithReceivedTime(
      evidence, envelope.gmailReceivedAtMs, ordersInReconciliationWindow,
    )
    : correlateUntrustedEmailAmount(evidence, ordersInReconciliationWindow);
  return result("NEW_REVIEW_EVIDENCE", match.match, match.candidateOrderId, receipt);
}
