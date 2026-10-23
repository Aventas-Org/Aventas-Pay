# Checkout staging and production runbook

The checkout Worker routes, page, and bot integration are already in their respective repositories. Checkout remains disabled by default. Passing repository CI is code validation, not staging sign-off or production activation.

## Read-only platform inventory (2026-10-23)

Recheck before any rollout; these are observations, not provisioning steps.

- Cloudflare production Worker `aventas` lists `ADMIN_EMAILS`, `BOT_SYNC_KEY`, `DISCORD_CLIENT_ID`, and `DISCORD_CLIENT_SECRET` as secrets. It does **not** list `PAYMENT_API_SECRET` or `PAYMENT_TOKEN_SECRET`.
- The production `aventas-db` D1 database has no `checkout_%` tables (`sqlite_master` query returned zero rows). The account lists `legion_db`, `aventas-db`, and `aventas-store`; none is identified as an isolated checkout staging database. The website repository has no `[env.staging]` Worker/D1 binding.
- Railway project `Aventas Shop`, service `legion-bot`, production is running bot commit `f52cbb74e860c84474011cebbde472e1583e0682`. That commit has neither `services/avantas_checkout/` nor `services/checkout_link_patch.py`. Its variable names contain no checkout flag, checkout API/base URL, or payment API secret.
- The current bot checkout fix is proposed in [bot PR #22](https://github.com/Aventas-Org/Aventas-bot/pull/22). Bot catalogue PR #21 is independent and must not be included in checkout rollout by accident.

## Configuration contract

Website Worker:

- `PAYMENT_API_SECRET`: server-to-server bearer secret shared with the bot.
- `PAYMENT_TOKEN_SECRET`: independent, website-only token derivation secret.
- `PAYMENT_WEBSITE_BASE_URL=https://aventasgaming.com` in production.

Bot (prefixed names take precedence; `CHECKOUT_ENABLED`, `WEBSITE_BASE_URL`, `PAYMENT_API_URL`, and `PAYMENT_API_SECRET` remain supported aliases):

- `AVENTAS_CHECKOUT_ENABLED=false` until staging sign-off.
- `AVENTAS_WEBSITE_BASE_URL=https://aventasgaming.com` in production.
- `AVENTAS_PAYMENT_API_URL=https://aventasgaming.com` in production. This is the origin; the client appends `/api/payments/checkout-sessions` itself.
- `AVENTAS_PAYMENT_API_SECRET`: same value as Worker `PAYMENT_API_SECRET`.
- Optional `AVENTAS_CHECKOUT_CONNECT_TIMEOUT`, `AVENTAS_CHECKOUT_TOTAL_TIMEOUT`, `AVENTAS_CHECKOUT_MAX_RETRIES`, `AVENTAS_CHECKOUT_TTL_SECONDS` (and corresponding unprefixed aliases).

Use staging-specific origins and secrets for an isolated staging stack. Never use the disabled workers.dev hostname. Configure secrets in the platform secret stores, not git.

## Operator sequence

1. Review and merge the final Pay, website, and bot PRs and record the exact deployed commits. Keep bot catalogue PR #21 separate.
2. Provision an isolated staging Worker and D1 database if they do not already exist, and add an explicit staging Worker configuration and D1 binding. Confirm the binding points to staging, then apply website migrations `0001_checkout_sessions.sql`, `0002_rate_limits.sql`, and `0003_verification_uniqueness.sql` in that order. Confirm `checkout_sessions`, `checkout_session_events`, `checkout_rate_limits`, and the provider-reference unique index exist. Never use production D1 as staging.
3. Set the staging Worker secrets and staging bot variables above; leave the production flag false. Confirm names without printing secret values.
4. Run health and contract checks on staging: unauthenticated create/cancel/verify return 401; malformed or missing public token fails safely; missing tables cause safe 5xx responses; no internal IDs or secrets appear in status responses.
5. With fake payment data and a controlled staging order, exercise create/reuse, exact saved amount after wallet deduction, UPI snapshot and QR, public polling, trusted staff or verified-email transition, replay, cancellation, and expiry. Confirm one provider reference cannot pay two orders. A page visit, QR scan, screenshot, or poll must never mark PAID.
6. Disable checkout and separately make the staging API unreachable. Confirm the Discord manual UPI, QR, screenshot, approval, fulfilment, loyalty, and sales paths still work and verification latency stays bounded.
7. Restrict the staging bot/guild to one controlled test account, then enable checkout there. The current feature flag is global within a bot deployment; it is not an account allowlist. Observe error rate, latency, one-session idempotency, notification failures, and browser state transitions. Record the test order and results.
8. Define measurable acceptance criteria before production activation: all staging cases pass; no wrong amount or recipient; no untrusted PAID transition; no secret/token log leak; bot verification and delivery are unaffected by website failure; required CI succeeds; production D1 and Worker bindings are verified. Require operator approval for production migrations, secrets, deploys, and flag changes.

## Rollback

Set the bot checkout flag to false first so new orders keep the manual flow. If needed, roll back the Worker and bot to the recorded prior commits. Existing checkout sessions may expire; reconcile any verified bot orders whose website notification failed. The additive tables can remain in place. Do not drop tables during an incident or while sessions may be active.
