# Aventas Pay: production release gates (verified 2026-11-06)

**Decision: NO-GO for activating live hosted checkout.** Code integration and
GitHub CI do not replace staging payment acceptance or live infrastructure
verification. This is a read-only status snapshot and operator checklist,
not approval to mutate Cloudflare or production payment settings.

## Verified repository / platform state

- Pay [PR #3](https://github.com/Aventas-Org/Aventas-Pay/pull/3)
  merged at `cfe55f82d1ccdffddd9da144080afbd62fd4df9e`; checkout
  tests/typecheck, bot cross-system tests and frontend tests/typecheck are green.
  It aligns canonical replay validation with the website's existing handler.
- Website checkout create/status/cancel/verify routes and customer page are on
  `main`. Website [PR #129](https://github.com/Aventas-Org/Aventas-website/pull/129)
  was merged and prevents misleading duplicate-payment advice and rendering
  unsafe QR/UPI instructions. This does **not** attest bank settlement.
- Bot [PR #33](https://github.com/Aventas-Org/Aventas-bot/pull/33)
  merged at `7a79702ad87d28245627953eb9d7e80c95b355e4`; CI is green.
  Its trusted receipt notification now derives contract-valid opaque
  provider-reference digests (including Slice email Message-IDs).
- Railway `Aventas Shop` production service `legion-bot` automatically
  deployed that bot merge and reported SUCCESS on 2026-11-06. Logs show the
  Discord gateway connected and the bot online. The redacted production
  variable-name inventory contains **no** checkout enablement, payment API
  secret or checkout API/base URL names. Only the production Railway
  environment was listed. Thus no hosted checkout activation is evidenced.
- **Cloudflare was not accessible to this audit on 2026-11-06.** The previous
  2026-10-23 read-only inventory in DEPLOYMENT_CHECKLIST.md found no checkout
  tables in production D1, no payment Worker secrets, and no isolated staging
  Worker/D1. Recheck live Cloudflare resources before relying on that inventory.

## Required release sequence (all evidence must be recorded)

1. **Platform owner:** provision and identify isolated *staging* Worker/D1,
   route and environment bindings. Apply website migrations `0001`, `0002`,
   `0003` to **staging only**; verify session/event/rate-limit tables and
   provider-reference uniqueness. Do not point staging at production D1.
2. **Security/operator:** configure independent staging `PAYMENT_API_SECRET`
   (shared only with staging bot) and Worker-only `PAYMENT_TOKEN_SECRET`;
   confirm their names and correct bindings without printing values. Restrict
   the staging Discord deployment to a controlled test guild/account.
3. **QA + payments:** with fake funds and synthetic receipts, prove exact
   persisted post-wallet order amount equals UPI snapshot/QR; no customer
   click, screenshot, redirect or polling can mark PAID; trusted staff or
   uniquely matched Slice verification can. Replays with changed facts
   must return 409, identical retries must return the same URL, and one
   receipt must never verify two orders.
4. **Reliability:** test expiration, cancellation, network timeout,
   malformed links, 401 for untrusted create/cancel/verify, safe public
   fields, 429 rate limits, no leaking tokens or secrets, and no double-pay
   guidance. Test bot/manual UPI, review, fulfillment and delivery with
   hosted checkout disabled **and** with website unreachable.
5. **Operations:** reconcile trusted bot orders that were paid but failed
   notification to the website, since bot and D1 do not share a transaction.
   Document support resolution, logs/alerts, bounded verification latency,
   customer-facing incident response and rollback drill. Keep the
   independent GST quote/payment/invoice release gate closed.
6. **Owner approval:** record final CI SHAs, staging deployment IDs,
   acceptance evidence and rollback versions. Only then separately authorize
   production Worker/D1 migrations, secrets, deploy, monitored canary and
   checkout flag. Live bank receipt verification remains an operator duty.

## Rollback

First set bot checkout enablement to false so manual UPI remains available.
Roll back Worker/bot to recorded known-good versions if needed. Reconcile
bot-verified orders with expired/pending website sessions. Never delete
checkout tables, rotate token secrets mid-session or conduct real-money
tests as part of a staging drill.

See [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) for the full
environment contract, migration instructions and test scenarios.
