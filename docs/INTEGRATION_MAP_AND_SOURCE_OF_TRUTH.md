# Checkout integration and source of truth

Updated 2026-11-06 against merged Pay, Aventas-website and Aventas-bot code.
The release board is [#7](https://github.com/Aventas-Org/Aventas-Pay/issues/7).
Code integration is complete enough for isolated testing; live activation still
requires staging and operator evidence.

| Fact | Authority | Consumer |
| --- | --- | --- |
| Buyer, product, saved payable amount after wallet adjustment | Bot order database | Authenticated checkout create |
| Recipient | Bot-selected payment profile, snapshotted in checkout | Customer instructions and QR |
| Checkout lifecycle | Website D1 session state | Customer status page |
| Funds actually received | Staff independently checking merchant bank/PSP account | Bot verification flow |
| Fulfillment and delivery | Bot order database and authorized staff | Discord customer and delivery flow |
| Website notification retry | Opt-in bot transactional outbox | Trusted website verify endpoint |

## Request and verification flow

1. The bot reads a persisted order and enforces buyer ownership before HTTP.
   Hosted checkout is optional and defaults off. Its client accepts only the
   configured website's exact capability URL, rejects HTTP redirects and
   redacts status capability paths from logs.
2. The Worker requires a dedicated integration secret for create/cancel/verify.
   Authenticated create requires an explicit DNS HTTPS
   `PAYMENT_WEBSITE_BASE_URL` matching the request origin. It never builds a
   payment URL from forwarded host headers or a missing configuration fallback.
3. Pay validates immutable order facts, expiry, idempotency and atomic paid-order
   exclusion. Website CI checks all 19 vendored modules and three migrations
   against a pinned public Pay revision; update the vendor manifest and pin
   together after reviewed changes.
4. The customer reads a minimal token-gated projection. A page visit, QR scan,
   screenshot, UTR submission or poll never marks payment received. QR and UPI
   instructions must match the stored snapshot; stale, invalid and terminal
   views cannot invite another payment.
5. Authorized staff independently verify actual funds, amount, currency,
   recipient and unique receipt before confirming the bot order. The trusted
   bot sends an opaque provider-reference digest to the website's verify
   endpoint. The website records that assertion; it does not verify the bank.
6. With separately migrated, explicitly enabled reconciliation, the bot stages
   notification inside the order transaction. Bounded retries recheck local
   VERIFIED status. Auth failures, missing/terminal sessions, receipt conflicts
   and exhausted retries require staff reconciliation; no dead session is
   revived and no financial status is inferred from a notification error.

## Email is not settlement proof

The historical Slice matcher searches merchant email text. Sender/body matching
and a matching screenshot do not independently authenticate bank settlement.
`AVENTAS_SLICE_AUTO_APPROVAL_ENABLED` is false by default. Neither checkout nor
outbox activation may enable it. A future automated settlement release requires
an independently authenticated bank/PSP integration, replay protection and
separate staging/operator approval. Credentials for an inbox are not approval.

## Failure boundaries

The bot and D1 do not share a transaction. Bot verification and delivery must
continue to work while the website is unavailable. A customer whose account
was debited must not be instructed to send funds again merely because a session
expired, was cancelled, or still looks pending. Staff reconcile against the
merchant ledger. The outbox reduces lost website notices but does not remove
this operational duty.

See [the operations runbook](PAYMENT_OPERATIONS_RUNBOOK.md),
[release gates](WORK_REMAINING_BLOCKED.md), website
[staging acceptance](https://github.com/Aventas-Org/Aventas-website/blob/main/docs/checkout-staging-acceptance.md)
and bot [outbox rollout](https://github.com/Aventas-Org/Aventas-bot/blob/main/docs/checkout-reconciliation-rollout.md).
