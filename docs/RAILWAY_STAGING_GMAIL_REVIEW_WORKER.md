# Aventas Pay — private Railway staging Gmail review worker

This worker runs as a **separate Railway service** in the existing
`Aventas Pay Staging` project. It has no HTTP listener, no public domain,
no Discord bot token, no customer fulfillment capability and no bank
credentials. It never calls `/verify`. It is not a payment provider.

## Run/deploy

GitHub repo: `Aventas-Org/Aventas-Pay`.
Railway service: `aventas-gmail-review-staging`, in the **staging**
environment only. Set the root directory to `website` and start command
`bun run scripts/staging-gmail-review-worker.ts`. Configure one replica
and attach a persistent `/data` volume (do not share the bot volume).
Restart on crashes. Do NOT expose a Railway domain.

Mandatory baseline variables:

- `APP_ENV=staging`
- `GMAIL_REVIEW_MODE=synthetic` (safe initial smoke mode)
- `GMAIL_REVIEW_ENABLED=false` (must remain false until consent and review)
- `RAILWAY_ENVIRONMENT_NAME=staging` (set by Railway)
- `RAILWAY_VOLUME_MOUNT_PATH=/data` (provided by Railway volume)

The worker executes one tick every **10 seconds**. The synthetic test
transport never calls Google, and the same synthetic Gmail message
deduplicates durably in `/data/aventas-gmail-review.sqlite3` after its
first match. Logs include mode, counts, cycle number and explicit
`paymentVerified=false`, `canFulfill=false`. No real email, UTR,
balance, sender, order or tokens are logged.

## Later: enable actual Gmail read-only REVIEW

The `oauth` mode is fail-closed until *all* of the following are
provisioned as **protected staging secrets**:

- `GMAIL_REVIEW_MODE=oauth`
- `GMAIL_REVIEW_ENABLED=true`
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REFRESH_TOKEN`
- `GMAIL_CREDIT_ALERT_SENDER` (exact known sender filter, not a trust proof)
- `GMAIL_MAILBOX_CONNECTION_ID` (opaque non-personal stable identifier)
- `STAGING_GMAIL_SNAPSHOT_TOKEN` (dedicated high-entropy bearer secret shared only with staging Worker; never use a production account token)

The operator must complete Google's actual OAuth consent flow with
`gmail.readonly` for the intended mailbox. ChatGPT's existing Gmail
connector DOES NOT grant or provide an OAuth token to this service and
must never be copied into Railway.

Each tick first calls the **fixed, staging-only Worker snapshot endpoint** for server-owned
synthetic checkout snapshots with source `staging_synthetic_upi`. If
none exist, the worker deliberately does not read Gmail. If any row is
malformed or from any other checkout source, the tick fails closed. The
OAuth adapter requests a short-lived token from Google's exact OAuth
endpoint and reads only bounded Gmail message candidates. The review
DB stores SHA-256 evidence and possible matching order IDs only. In
every mode `paymentVerified=false` and `canFulfill=false`.

**No live payments or autoapproval**: Gmail email arrival, amount, date,
body, sender and UTR can be forged/delayed and cannot confirm bank credit.
Keep `AVENTAS_SLICE_AUTO_APPROVAL_ENABLED=false` in the bot and do not
route personal savings UPI receipts to customer fulfillment. Commercial
collections need an account approved for business UPI receipts and an
independent bank-authenticated credit verification source.

## Staging acceptance

1. Inspect Railway service logs: `staging_gmail_review_started` in
   synthetic mode, then one `newlyStaged`/queued match (never PAID).
2. Check it has exactly one replica, no domain and the persistent volume.
3. Ensure the service never has `DISCORD_TOKEN`, `PAYMENT_UPI_ID`,
   `AVENTAS_PAYMENT_API_SECRET` or production bank/API secrets.
4. Run `bun test test/stagingGmailReviewWorker.test.ts` and full
   `bun test` before release.
5. Before OAuth mode, inspect Google consent, token scope, Cloudflare
   D1 API token scope, logs, replay behavior, expiry and sender spoofing
   with fake mail. Do not log or store the raw mailbox contents.

**Limit**: the worker only recognizes test checkout source
`staging_synthetic_upi`; it will not match real customer orders.
Turning it on cannot make the product production-ready without
proper quote/payment binding and independently verified bank settlement.

## Staging snapshot proxy (no Cloudflare account API token)

The worker uses a fixed `POST https://pay-staging.aventasgaming.com/api/internal/staging-gmail-snapshot` endpoint, not the Cloudflare account D1 API. Both sides must have the **same** cryptographically random capability in these private variables:

- Cloudflare `aventas-staging` Worker: `STAGING_GMAIL_SNAPSHOT_SECRET` (secret_text)
- Railway `aventas-gmail-review-staging`: `STAGING_GMAIL_SNAPSHOT_TOKEN` (private variable)

The endpoint is unavailable in production and exposes only non-PAID synthetic test order records. Never reuse payment credentials or publish this bearer value in git, logs, screenshots or chat.

## One-time authenticated connection probe

Before enabling Gmail OAuth, set `GMAIL_REVIEW_MODE=snapshot_probe` while the private snapshot token is present. This makes the worker query ONLY the bounded, non-PAID staging synthetic order snapshot feed every 10 seconds. It does not call Google, insert email receipts or verify any payment. Check the Railway deploy log for `staging_gmail_review_tick`, `mode=snapshot_probe` and no `staging_gmail_review_tick_unavailable`. Restore `GMAIL_REVIEW_MODE=synthetic` immediately after confirming the connection. Never leave the probe enabled as a production mode.
