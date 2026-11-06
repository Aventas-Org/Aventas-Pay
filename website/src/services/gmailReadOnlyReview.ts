/**
 * Gmail API read-only adapter for zero-gateway-fee UPI *email evidence*.
 *
 * OAuth 2 access token must be acquired server-side with gmail.readonly
 * consent, stored outside this module, and never passed to a browser.
 *
 * The adapter NEVER authenticates a bank credit or marks an order paid.
 * It selects a small bounded set of messages from the Gmail API and feeds
 * the existing staff-review-only amount matcher/durable review queue.
 */
import { Buffer } from "node:buffer";
import type { SqlExecutor } from "../adapters/sqlPort";
import type { ReviewOrderSnapshot } from "./payment/amountOnlyReview";
import type { InboxEvidenceEnvelope } from "./payment/emailReviewIntake";
import { queueEmailEvidenceForReview } from "./sqlEmailReviewStore";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const MAX_BODY_CHARS = 16_384;
const MAX_MESSAGES = 50;
const MAILBOX_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

export interface GmailReadOnlyConfig {
  /** Ephemeral server-side OAuth token, never logged or persisted here. */
  readonly accessToken: string;
  readonly mailboxConnectionId: string;
  /** Gmail's sender search is only a filter, NOT sender authentication. */
  readonly candidateAlertSender: string;
  readonly nowMs: number;
  readonly lookbackHours: number;
  readonly maxMessages: number;
}

type Fetcher = typeof fetch;

interface GmailMessage {
  readonly id?: unknown;
  readonly payload?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function validConfig(config: GmailReadOnlyConfig): boolean {
  return !!config &&
    typeof config.accessToken === "string" &&
    config.accessToken.length >= 10 && config.accessToken.length <= 4096 &&
    typeof config.mailboxConnectionId === "string" &&
    MAILBOX_ID.test(config.mailboxConnectionId) &&
    typeof config.candidateAlertSender === "string" &&
    EMAIL_ADDRESS.test(config.candidateAlertSender) &&
    Number.isSafeInteger(config.nowMs) && config.nowMs > 0 &&
    Number.isSafeInteger(config.lookbackHours) &&
    config.lookbackHours >= 1 && config.lookbackHours <= 168 &&
    Number.isSafeInteger(config.maxMessages) &&
    config.maxMessages >= 1 && config.maxMessages <= MAX_MESSAGES;
}

async function requestJson(
  url: string,
  token: string,
  fetcher: Fetcher,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      redirect: "error",
    });
  } catch {
    throw new Error("GMAIL_REVIEW_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("GMAIL_REVIEW_UNAVAILABLE");
  try {
    return await response.json();
  } catch {
    throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  }
}

function decodeBody(x: unknown): string | null {
  if (typeof x !== "string" || x.length === 0 || x.length > 30_000 ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(x)) return null;
  try {
    const buffer = Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buffer.length === 0 || buffer.length > MAX_BODY_CHARS) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return decoded.length <= MAX_BODY_CHARS ? decoded : null;
  } catch {
    return null;
  }
}

function findTextPart(payload: unknown, preferred: string, depth = 0): string | null {
  if (!isRecord(payload) || depth > 10) return null;
  if (payload.mimeType === preferred && isRecord(payload.body)) {
    return decodeBody(payload.body.data);
  }
  const children = payload.parts;
  if (Array.isArray(children) && children.length <= 30) {
    for (const child of children) {
      const text = findTextPart(child, preferred, depth + 1);
      if (text) return text;
    }
  }
  return null;
}

function readEnvelope(
  message: GmailMessage,
  mailboxConnectionId: string,
): InboxEvidenceEnvelope | null {
  if (!isRecord(message) || typeof message.id !== "string" ||
      !MESSAGE_ID.test(message.id) || !isRecord(message.payload)) return null;
  const headers = message.payload.headers;
  if (!Array.isArray(headers) || headers.length > 100) return null;
  const h = (name: string): string => {
    const candidate = headers.find((entry) =>
      isRecord(entry) && typeof entry.name === "string" &&
      entry.name.toLowerCase() === name);
    return isRecord(candidate) && typeof candidate.value === "string"
      ? candidate.value : "";
  };
  const from = h("from");
  const subject = h("subject");
  if (!from || !subject || from.length > 512 || subject.length > 512) return null;
  const body = findTextPart(message.payload, "text/plain") ??
    findTextPart(message.payload, "text/html");
  if (!body) return null;
  return {
    mailboxConnectionId,
    mailboxMessageId: message.id,
    email: { from, subject, body },
  };
}

/**
 * Fetches a single bounded page, with a provider-issued Gmail message ID.
 * No sender-header filtering is treated as settlement proof.
 */
export async function fetchGmailReviewEvidence(
  config: GmailReadOnlyConfig,
  fetcher: Fetcher = fetch,
): Promise<readonly InboxEvidenceEnvelope[]> {
  if (!validConfig(config)) throw new Error("INVALID_GMAIL_REVIEW_CONFIG");
  const cutoff = Math.floor((config.nowMs - config.lookbackHours * 3_600_000) / 1000);
  if (cutoff <= 0) throw new Error("INVALID_GMAIL_REVIEW_CONFIG");

  const url = new URL(GMAIL_API);
  url.searchParams.set("q", `after:${cutoff} from:${config.candidateAlertSender}`);
  url.searchParams.set("maxResults", String(config.maxMessages));
  url.searchParams.set("includeSpamTrash", "false");

  const listing = await requestJson(url.toString(), config.accessToken, fetcher);
  if (!isRecord(listing)) throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  const messages = listing.messages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages) || messages.length > config.maxMessages) {
    throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  }
  const seen = new Set<string>();
  const result: InboxEvidenceEnvelope[] = [];
  for (const item of messages) {
    if (!isRecord(item) || typeof item.id !== "string" ||
        !MESSAGE_ID.test(item.id)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const msgUrl = `${GMAIL_API}/${encodeURIComponent(item.id)}?format=full`;
    const full = await requestJson(msgUrl, config.accessToken, fetcher);
    const envelope = readEnvelope(full as GmailMessage, config.mailboxConnectionId);
    if (envelope && envelope.mailboxMessageId === item.id) {
      result.push(envelope);
    }
  }
  return result;
}

export interface GmailReviewSyncResult {
  readonly examined: number;
  readonly newlyStaged: number;
  readonly repeatedOrConflicting: number;
  readonly possibleOrderMatches: number;
  readonly paymentVerified: false;
  readonly canFulfill: false;
}

/**
 * Injectable bounded scheduler entrypoint, suitable for a separately
 * authorized staging cron. Authoritative order snapshots must come from
 * the trusted bot/order database, NOT email content or a public API.
 */
export async function syncGmailEvidenceToReviewQueue(
  db: SqlExecutor,
  config: GmailReadOnlyConfig,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
  fetcher: Fetcher = fetch,
): Promise<GmailReviewSyncResult> {
  const emails = await fetchGmailReviewEvidence(config, fetcher);
  let newlyStaged = 0;
  let repeatedOrConflicting = 0;
  let possibleOrderMatches = 0;
  for (const envelope of emails) {
    const outcome = await queueEmailEvidenceForReview(
      db, envelope, ordersInReconciliationWindow, config.nowMs,
    );
    if (outcome.kind === "INSERTED") {
      newlyStaged += 1;
      if (outcome.intake.match === "SINGLE_POSSIBLE_ORDER") possibleOrderMatches += 1;
    } else {
      repeatedOrConflicting += 1;
    }
  }
  return {
    examined: emails.length,
    newlyStaged,
    repeatedOrConflicting,
    possibleOrderMatches,
    paymentVerified: false,
    canFulfill: false,
  };
}
