# Staging Gmail OAuth readonly polling contract — UPI-only

This library is **not yet a deployed scheduler**. It is a one-shot, testable
staging poll implementation using Google OAuth2 refresh tokens and the Gmail
API `gmail.readonly` permission. Every call needs explicit staging enablement.
This is separate from the ChatGPT Gmail connector: that connector's tokens
cannot and must not be copied to Aventas/Railway.

## Operator setup (staging only)

1. Create a Google OAuth client on an account controlled by Aventas. Use
   the narrow scope `https://www.googleapis.com/auth/gmail.readonly`.
   Obtain user consent through Google's official authorization-code flow.
2. Put the **client ID, client secret, refresh token** into protected Railway
   staging environment secrets, never Discord, browser JavaScript, git, URLs,
   or logs. Do not reuse credentials from production or personal apps.
3. Configure mailbox connection ID (opaque), exact sender search filter,
   a bounded lookback, and a locked-down singleton Railway scheduler.
   Only allow `APP_ENV=staging`, `GMAIL_REVIEW_ENABLED=true`; keep
   `GMAIL_REVIEW_ENABLED=false` for any production service.
4. Scheduler may invoke `stagingReadOnlyGmailReviewTick` no faster than
   **once per 10 seconds**. Coordinate replicas using a single-instance
   process or a durable lease. The Gmail read-only adapter only fetches a
   bounded page of candidates, and the SQL review inbox uses Gmail
   provider-message-ID digests to dedupe replays.
5. `trustedOrders` must come from an independently authenticated checkout
   snapshot and must include exact INR amount, PENDING/terminal status and
   creation/expiry times. Never derive price or recipient from email.
6. Record synthetic end-to-end tests with fake Gmail responses before using
   actual mail. Periodic 10-second polling has **not** been started by this
   code. Rate limits/Google API quotas and retry backoff must be observed.

## Security invariant

The OAuth response and mail sender are not independent bank settlement.
Every match is a **review-only candidate**. No attempt may mark a session
`PAID`, mint delivery credentials, send inventory or trigger fulfillment.
No UTR, email body, balance, personal account suffix or OAuth token is
stored in the review ledger.

If the real receiving bank has not authorized commercial UPI collections
on this account, keep **real money disabled**. This does not add cards,
wallets or a payment gateway.
