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
  readonly durableBacklog?: boolean;
  /** Revisit recent completed ranges using an independent durable cursor. */
  readonly replayRecent?: boolean;
}

type Fetcher = typeof fetch;

interface GmailMessage {
  readonly id?: unknown;
  /** Gmail API internalDate, a string containing Unix epoch milliseconds. */
  readonly internalDate?: unknown;
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

/** Fetch Gmail JSON with redacted errors and a bounded request lifetime. */
async function requestJson(
  url: string,
  token: string,
  fetcher: Fetcher,
  continuation = false,
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("GMAIL_REVIEW_UNAVAILABLE");
  }
  if (continuation && response.status === 400) {
    throw new Error("GMAIL_REVIEW_CURSOR_REJECTED");
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
  // The RFC-5322 Date header and any body timestamp are untrusted.
  // For normal SMTP mail Gmail internalDate reflects Google acceptance time.
  // Imported mail may have a caller-selected internalDate: still only a hint.
  const rawReceived = message.internalDate;
  const received = typeof rawReceived === "string" &&
    /^\d{13}$/.test(rawReceived) ? Number(rawReceived) : null;
  const gmailReceivedAtMs = received !== null &&
    Number.isSafeInteger(received) && received > 0 ? received : undefined;
  return {
    mailboxConnectionId,
    mailboxMessageId: message.id,
    email: { from, subject, body },
    ...(gmailReceivedAtMs === undefined ? {} : { gmailReceivedAtMs }),
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

  return (await fetchEvidencePage(config, fetcher, cutoff)).emails;
}

interface ScanWindow {
  readonly after_sec: number;
  readonly before_sec: number;
  readonly page_token: string | null;
}

/** Fetch one Gmail page inside a fixed window when a durable scan is active. */
async function fetchEvidencePage(
  config: GmailReadOnlyConfig,
  fetcher: Fetcher,
  after: number,
  window?: ScanWindow,
): Promise<{ emails: InboxEvidenceEnvelope[]; nextPageToken: string | null }> {
  const url = new URL(GMAIL_API);
  const before = window ? ` before:${window.before_sec}` : "";
  url.searchParams.set("q", `after:${after}${before} from:${config.candidateAlertSender}`);
  url.searchParams.set("maxResults", String(config.maxMessages));
  url.searchParams.set("includeSpamTrash", "false");
  if (window?.page_token) url.searchParams.set("pageToken", window.page_token);

  const listing = await requestJson(url.toString(), config.accessToken, fetcher, !!window?.page_token);
  if (!isRecord(listing)) throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  const token = listing.nextPageToken;
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
      throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
    }
    if (!window) throw new Error("GMAIL_REVIEW_BACKLOG");
    if (token === window.page_token) throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  }
  const messages = listing.messages === undefined ? [] : listing.messages;
  if (!Array.isArray(messages) || messages.length > config.maxMessages) {
    throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
  }
  const seen = new Set<string>();
  const result: InboxEvidenceEnvelope[] = [];
  for (const item of messages) {
    if (!isRecord(item) || typeof item.id !== "string" ||
        !MESSAGE_ID.test(item.id)) {
      // A corrupt provider response must not acknowledge an incomplete page.
      // Leave its durable checkpoint intact so a later tick can retry it.
      throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const msgUrl = `${GMAIL_API}/${encodeURIComponent(item.id)}?format=full`;
    const full = await requestJson(msgUrl, config.accessToken, fetcher);
    if (!isRecord(full) || full.id !== item.id) {
      throw new Error("GMAIL_REVIEW_INVALID_RESPONSE");
    }
    const envelope = readEnvelope(full as GmailMessage, config.mailboxConnectionId);
    if (envelope && envelope.mailboxMessageId === item.id) {
      result.push(envelope);
    }
  }
  return { emails: result, nextPageToken: token ?? null };
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
  const forward = await syncScanPage(db, config, ordersInReconciliationWindow, fetcher, false);
  if (!config.durableBacklog || !config.replayRecent) return forward;
  const replay = await syncScanPage(db, config, ordersInReconciliationWindow, fetcher, true);
  return {
    examined: forward.examined + replay.examined,
    newlyStaged: forward.newlyStaged + replay.newlyStaged,
    repeatedOrConflicting: forward.repeatedOrConflicting + replay.repeatedOrConflicting,
    possibleOrderMatches: forward.possibleOrderMatches + replay.possibleOrderMatches,
    paymentVerified: false,
    canFulfill: false,
  };
}

/** Process one bounded page; replay and forward progress have separate checkpoints. */
async function syncScanPage(
  db: SqlExecutor,
  config: GmailReadOnlyConfig,
  ordersInReconciliationWindow: readonly ReviewOrderSnapshot[],
  fetcher: Fetcher,
  replay: boolean,
): Promise<GmailReviewSyncResult> {
  if (!validConfig(config)) throw new Error("INVALID_GMAIL_REVIEW_CONFIG");
  // ':' cannot occur in a configured sender address. This reserved scan key
  // never changes the actual Gmail query or the mailbox evidence identity.
  const key = [config.mailboxConnectionId,
    (replay ? "replay:" : "") + config.candidateAlertSender.toLowerCase()];
  let window: ScanWindow | undefined;
  let nextPageToken: string | null = null;
  let emails: readonly InboxEvidenceEnvelope[];
  if (config.durableBacklog) {
    const before = Math.floor(config.nowMs / 1000);
    const cutoff = before - config.lookbackHours * 3600;
    if (cutoff <= 0) throw new Error("INVALID_GMAIL_REVIEW_CONFIG");
    // Persist the fixed query before contacting Gmail. A restart resumes the
    // same time range even when the rolling lookback would move past it.
    await db.run(
      `INSERT INTO gmail_review_scan (mailbox_id, sender, after_sec, before_sec)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [...key, cutoff, before],
    );
    await db.run(
      `UPDATE gmail_review_scan SET before_sec = ?
       WHERE mailbox_id = ? AND sender = ? AND before_sec IS NULL AND after_sec + 1 < ?`,
      [before, ...key, before],
    );
    const state = await db.get<Omit<ScanWindow, "before_sec"> & { before_sec: number | null }>(
      `SELECT after_sec, before_sec, page_token FROM gmail_review_scan
       WHERE mailbox_id = ? AND sender = ?`, key,
    );
    if (!state) throw new Error("GMAIL_REVIEW_CURSOR_UNAVAILABLE");
    if (state.before_sec === null) {
      emails = [];
    } else {
      window = { ...state, before_sec: state.before_sec };
      try {
        ({ emails, nextPageToken } = await fetchEvidencePage(config, fetcher, window.after_sec, window));
      } catch (error) {
        if (error instanceof Error && error.message === "GMAIL_REVIEW_CURSOR_REJECTED") {
          // Re-enumerate the original range. Previously queued evidence deduplicates by Gmail ID.
          await advanceScan(db, key, window, null, false);
        }
        throw error;
      }
    }
  } else {
    emails = await fetchGmailReviewEvidence(config, fetcher);
  }
  let newlyStaged = 0;
  let repeatedOrConflicting = 0;
  let possibleOrderMatches = 0;
  for (const envelope of emails) {
    const outcome = await queueEmailEvidenceForReview(
      db, envelope, ordersInReconciliationWindow, config.nowMs,
      true, // Strict Gmail time check: no silent amount-only fallback.
    );
    if (outcome.kind === "INSERTED") {
      newlyStaged += 1;
      if (outcome.intake.match === "SINGLE_POSSIBLE_ORDER") possibleOrderMatches += 1;
    } else {
      repeatedOrConflicting += 1;
    }
  }
  // A crash before this write replays a page. Durable evidence insertion is
  // idempotent and always precedes the checkpoint.
  if (window) await advanceScan(db, key, window, nextPageToken, nextPageToken === null,
    replay ? Math.max(1, window.before_sec - config.lookbackHours * 3600) : undefined);
  return {
    examined: emails.length,
    newlyStaged,
    repeatedOrConflicting,
    possibleOrderMatches,
    paymentVerified: false,
    canFulfill: false,
  };
}


/** Advance only the scan state that produced the page just persisted. */
async function advanceScan(
  db: SqlExecutor,
  key: string[],
  window: ScanWindow,
  token: string | null,
  complete: boolean,
  replayAfterSec?: number,
): Promise<void> {
  // Overlap one second at the boundary to cover Gmail's second-based filters.
  const result = await db.run(
    `UPDATE gmail_review_scan SET after_sec = ?, before_sec = ?, page_token = ?
     WHERE mailbox_id = ? AND sender = ? AND after_sec = ? AND before_sec = ?
       AND page_token IS ?`,
    [complete ? (replayAfterSec ?? window.before_sec - 1) : window.after_sec,
      complete ? null : window.before_sec, token, ...key,
      window.after_sec, window.before_sec, window.page_token],
  );
  if (result.rowsAffected !== 1) throw new Error("GMAIL_REVIEW_CURSOR_CONFLICT");
}
