/**
 * Staging-only, single-tick OAuth2 Gmail read-only credit evidence polling.
 *
 * Do NOT run this in production or as a public API. Never authorize the
 * merchant bank balance, PAID status, refunds, or fulfillment using email.
 * Staging environment secrets are supplied by an operator/secret store, not
 * committed or exported to a browser. The caller schedules this function;
 * there is no uncontrolled interval or background job in this library.
 */
import type { SqlExecutor } from "../adapters/sqlPort";
import {
  syncGmailEvidenceToReviewQueue,
  type GmailReviewSyncResult,
} from "./gmailReadOnlyReview";
import type { ReviewOrderSnapshot } from "./payment/amountOnlyReview";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
const MAX_CONFIG_CHARS = 4096;

/** Operator-provisioned staging-only secrets. ALL values remain server-side. */
export interface StagingGmailOAuthConfig {
  readonly appEnv: string;
  readonly enabled: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly mailboxConnectionId: string;
  readonly candidateAlertSender: string;
  readonly nowMs: number;
  readonly maxMessages?: number;
  readonly lookbackHours?: number;
}
type Fetcher = typeof fetch;

function valid(config: StagingGmailOAuthConfig): boolean {
  return !!config && config.appEnv === "staging" && config.enabled === "true" &&
    typeof config.clientId === "string" && config.clientId.length >= 10 &&
    config.clientId.length <= MAX_CONFIG_CHARS &&
    typeof config.clientSecret === "string" && config.clientSecret.length >= 10 &&
    config.clientSecret.length <= MAX_CONFIG_CHARS &&
    typeof config.refreshToken === "string" && config.refreshToken.length >= 10 &&
    config.refreshToken.length <= MAX_CONFIG_CHARS &&
    typeof config.mailboxConnectionId === "string" &&
    SAFE_ID.test(config.mailboxConnectionId) &&
    typeof config.candidateAlertSender === "string" &&
    EMAIL.test(config.candidateAlertSender) &&
    Number.isSafeInteger(config.nowMs) && config.nowMs > 0 &&
    (config.maxMessages === undefined ||
      (Number.isSafeInteger(config.maxMessages) &&
       config.maxMessages >= 1 && config.maxMessages <= 20)) &&
    (config.lookbackHours === undefined ||
      (Number.isSafeInteger(config.lookbackHours) &&
       config.lookbackHours >= 1 && config.lookbackHours <= 48));
}
function record(x: unknown): x is Record<string,unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function validScope(x: unknown): boolean {
  if (x === undefined) return true; // OAuth refresh responses can omit scope.
  if (typeof x !== "string") return false;
  const scopes = x.trim().split(/\s+/);
  return scopes.length === 1 && scopes[0] === READONLY_SCOPE;
}

/** Each tick obtains a short-lived OAuth access token; never persist it. */
export async function stagingReadOnlyGmailReviewTick(
  db: SqlExecutor,
  config: StagingGmailOAuthConfig,
  trustedOrders: readonly ReviewOrderSnapshot[],
  fetcher: Fetcher = fetch,
): Promise<GmailReviewSyncResult> {
  if (!valid(config) || !Array.isArray(trustedOrders) ||
      trustedOrders.length > 1000) {
    throw new Error("STAGING_GMAIL_REVIEW_DISABLED");
  }
  // No arbitrary OAuth host. No browser transport. No log of response body.
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new Error("STAGING_GMAIL_OAUTH_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("STAGING_GMAIL_OAUTH_UNAVAILABLE");
  let token: unknown;
  try {
    token = await response.json();
  } catch {
    throw new Error("STAGING_GMAIL_OAUTH_INVALID_RESPONSE");
  }
  if (!record(token) ||
      typeof token.access_token !== "string" ||
      token.access_token.length < 10 ||
      token.access_token.length > MAX_CONFIG_CHARS ||
      token.token_type !== "Bearer" ||
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in < 60 || token.expires_in > 7200 ||
      !validScope(token.scope)) {
    throw new Error("STAGING_GMAIL_OAUTH_INVALID_RESPONSE");
  }
  return syncGmailEvidenceToReviewQueue(db, {
    accessToken: token.access_token,
    mailboxConnectionId: config.mailboxConnectionId,
    candidateAlertSender: config.candidateAlertSender,
    nowMs: config.nowMs,
    maxMessages: config.maxMessages ?? 10,
    lookbackHours: config.lookbackHours ?? 1,
  }, trustedOrders, fetcher);
}
