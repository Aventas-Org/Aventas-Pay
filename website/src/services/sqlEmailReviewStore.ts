/**
 * Durable, review-only SQL ledger for no-gateway fractional amount proposals
 * and replay-safe email evidence intake.
 *
 * Staging-prototype only: neither method changes order price, creates a QR,
 * reads mail, verifies a bank credit, or calls the trusted PAID endpoint.
 * A future quote must persist the reserved amount BEFORE customer acceptance.
 */
import type { SqlExecutor } from "../adapters/sqlPort";
import {
  stageInboxEmailForReview,
  type EmailReviewReceipt,
  type InboxEvidenceEnvelope,
  type InboxIntakeResult,
} from "./payment/emailReviewIntake";
import type { ReviewOrderSnapshot } from "./payment/amountOnlyReview";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ORDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function validWholePaise(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value % 100 === 0 &&
    value < Number.MAX_SAFE_INTEGER - 99;
}

export interface ReserveAmountInput {
  readonly recipientKey: string;
  readonly orderId: string;
  readonly baseAmountPaise: number;
  readonly createdAtMs: number;
}

export type ReserveAmountResult =
  | { readonly kind: "RESERVED" | "REPLAY"; readonly amountPaise: number }
  | { readonly kind: "EXHAUSTED" | "INVALID" | "ORDER_FACTS_CHANGED"; readonly amountPaise: null };

interface ReservationRow {
  readonly base_amount_paise: number;
  readonly amount_paise: number;
}

/**
 * A globally unique (per real recipient) price proposal. Do not use as the
 * invoice amount until an independently authorized pre-checkout quote has
 * accepted it and atomically bound it to the order.
 *
 * A unique SQL constraint (not an in-memory array) arbitrates concurrent
 * requests. 99 nonzero fractional values are available for each rupee base.
 */
export async function reserveFractionalAmountProposal(
  db: SqlExecutor,
  input: ReserveAmountInput,
): Promise<ReserveAmountResult> {
  if (!input || typeof input.recipientKey !== "string" ||
      !SAFE_ID.test(input.recipientKey) ||
      typeof input.orderId !== "string" || !ORDER_ID.test(input.orderId) ||
      !validWholePaise(input.baseAmountPaise) ||
      !Number.isSafeInteger(input.createdAtMs) || input.createdAtMs <= 0) {
    return { kind: "INVALID", amountPaise: null };
  }

  const getExisting = () => db.get<ReservationRow>(
    `SELECT base_amount_paise, amount_paise FROM payment_amount_reservations
     WHERE recipient_key = ? AND order_id = ?`,
    [input.recipientKey, input.orderId],
  );
  const existing = await getExisting();
  if (existing) {
    return existing.base_amount_paise === input.baseAmountPaise
      ? { kind: "REPLAY", amountPaise: existing.amount_paise }
      : { kind: "ORDER_FACTS_CHANGED", amountPaise: null };
  }

  for (let offset = 1; offset <= 99; offset += 1) {
    const candidate = input.baseAmountPaise + offset;
    const inserted = await db.run(
      `INSERT INTO payment_amount_reservations (
        recipient_key, order_id, base_amount_paise, amount_paise, created_at_ms
       ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [input.recipientKey, input.orderId, input.baseAmountPaise, candidate, input.createdAtMs],
    );
    if (inserted.rowsAffected === 1) {
      return { kind: "RESERVED", amountPaise: candidate };
    }
    // An identical order may have been reserved by a competing worker.
    const prior = await getExisting();
    if (prior) {
      return prior.base_amount_paise === input.baseAmountPaise
        ? { kind: "REPLAY", amountPaise: prior.amount_paise }
        : { kind: "ORDER_FACTS_CHANGED", amountPaise: null };
    }
  }
  return { kind: "EXHAUSTED", amountPaise: null };
}

interface EvidenceRow {
  readonly message_key_digest: string;
  readonly content_digest: string;
}

export type ReviewQueueOutcome =
  | { readonly kind: "INSERTED"; readonly intake: InboxIntakeResult }
  | { readonly kind: "DUPLICATE" | "CONTENT_CONFLICT" | "REJECTED"; readonly intake: InboxIntakeResult };

/**
 * Stores only opaque SHA256 digests and a staff-review candidate. A unique
 * primary key is the concurrent replay guard. No raw email, UTR or credentials
 * enter this SQL table. Mail access credentials are never accepted here.
 */
export async function queueEmailEvidenceForReview(
  db: SqlExecutor,
  envelope: InboxEvidenceEnvelope,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
  observedAtMs: number,
  requireGmailReceivedTime = false,
): Promise<ReviewQueueOutcome> {
  const invalid = !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0;
  if (invalid) {
    const intake = stageInboxEmailForReview(
      { mailboxConnectionId: "", mailboxMessageId: "", email: { from: "", subject: "", body: "" } },
      [], [],
    );
    return { kind: "REJECTED", intake };
  }
  const initial = stageInboxEmailForReview(
    envelope, [], ordersInReconciliationWindow, requireGmailReceivedTime,
  );
  if (initial.state !== "NEW_REVIEW_EVIDENCE" || !initial.receipt || !initial.match) {
    return { kind: "REJECTED", intake: initial };
  }
  const digest = initial.receipt.messageKeyDigest;
  const readPrior = () => db.get<EvidenceRow>(
    `SELECT message_key_digest, content_digest
     FROM payment_email_review_receipts WHERE message_key_digest = ?`,
    [digest],
  );
  const asPrior = (entry: EvidenceRow): EmailReviewReceipt => ({
    messageKeyDigest: entry.message_key_digest,
    contentDigest: entry.content_digest,
  });
  const prior = await readPrior();
  if (prior) {
    const intake = stageInboxEmailForReview(
      envelope, [asPrior(prior)], ordersInReconciliationWindow, requireGmailReceivedTime,
    );
    return {
      kind: intake.state === "DUPLICATE_MESSAGE" ? "DUPLICATE" : "CONTENT_CONFLICT",
      intake,
    };
  }
  const inserted = await db.run(
    `INSERT INTO payment_email_review_receipts (
      message_key_digest, content_digest, match_reason, candidate_order_id, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [digest, initial.receipt.contentDigest, initial.match, initial.candidateOrderId, observedAtMs],
  );
  if (inserted.rowsAffected === 1) return { kind: "INSERTED", intake: initial };
  const raced = await readPrior();
  if (!raced) {
    throw new Error("REVIEW_RECEIPT_WRITE_CONFLICT");
  }
  const intake = stageInboxEmailForReview(
    envelope, [asPrior(raced)], ordersInReconciliationWindow, requireGmailReceivedTime,
  );
  return {
    kind: intake.state === "DUPLICATE_MESSAGE" ? "DUPLICATE" : "CONTENT_CONFLICT",
    intake,
  };
}
