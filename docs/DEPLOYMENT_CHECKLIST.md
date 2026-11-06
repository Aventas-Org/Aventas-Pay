# Aventas Pay — controlled staging and production release checklist

**State (2026-11-06): NO-GO for live hosted checkout.** This checklist is a
release gate, not permission to create Cloudflare resources, access production
payment data, run migrations, set secrets, deploy, or move real money. Only
an authorized platform/payments operator may carry out the separately approved
staging changes below. All payments remain subject to independent merchant-bank
verification by trusted staff; an email or screenshot is not settlement proof.

**Source of truth:** [Pay release board #7](https://github.com/Aventas-Org/Aventas-Pay/issues/7),
[product release program](PRODUCT_RELEASE_PROGRAM_2026_11.md),
[operations runbook](PAYMENT_OPERATIONS_RUNBOOK.md),
[website staging acceptance](https://github.com/Aventas-Org/Aventas-website/blob/main/docs/checkout-staging-acceptance.md),
[bot reconciliation rollout](https://github.com/Aventas-Org/Aventas-bot/blob/main/docs/checkout-reconciliation-rollout.md).
Track A is **human-verified hosted UPI instructions/status**. Automated authenticated
bank/PSP settlement is a separate Track B and must never use the legacy
Slice-mailbox/screenshot approval heuristic.

## 1. What is known, and what is NOT verified

| Component | Code/inventory evidence | Release state |
| --- | --- | --- |
| Website production | `wrangler.toml` targets `aventas` / `aventas-db`; historical Cloudflare inventory from 2026-10-23 only | **Recheck live before any operation** |
| Website staging | Committed `wrangler.staging.toml` pins historically reported **existing** `aventas-staging` Worker and `aventas-staging-db` D1. `workers_dev=false`, `routes=[]`, no approved HTTPS route established | **Live account, deployed revision, bindings, schema and route unknown** |
| Railway production bot | `Aventas Shop` / `legion-bot`, `main`, mounted persistent `/data` volume; source/variable-name inventory and successful Discord gateway startup observed Nov 6 | Production-only evidence; **not a staging bot** |
| Railway staging bot | No isolated service/DB/guild evidenced in connected project | **Blocked** — request an independent staging service, protected DB and test guild |
| Checkout and bot reconciliation | Feature code merged with separate flags, migration and fail-closed contracts | **Default off**; no staging activation evidence |
| GST | Quote-preview foundation and fail-closed payment/legacy routes | **Do not enable** until signed financial snapshot, invoice binding and qualified tax approval |

**Do not duplicate staging resources** because an old inventory or inaccessible
account appears empty. The website repository already has a reviewed staging
configuration and historical named staging resources. Validate what exists
using fresh authenticated, read-only account evidence first.

## 2. Read-only identity and isolation (Pay #8, #9, #10)

The platform owner must record the actual account, production/staging Worker
names and deployed revisions, D1 database **IDs and schema only** (no rows),
bound `DB` target, routes, SSL/TLS hostname, DNS isolation, and deployment
history. Confirm that staging and production D1 IDs are different, that the
staging Worker cannot bind production D1, and that the staging domain
cannot route to the production Worker. Verify whether the historical
`aventas-staging` and `aventas-staging-db` resources still exist; never
create replacements without a separate signed infrastructure change.

In `Aventas-website`, the following **offline/read-only** checks are safe
and do not deploy or migrate:

```sh
node scripts/staging-config.mjs --check
node --test scripts/staging-config.test.mjs
# Once a platform operator has captured current authenticated D1 name/ID inventory:
node scripts/staging-config.mjs --check --inventory /protected/path/d1-list.json
```

The static config, GitHub dry-run and supplied D1 inventory alone do **not**
establish live Worker deployment, safe secret separation, DNS/TLS,
or an isolated bot. Explicitly record unknowns instead of marking PASS.

## 3. Staging-only infrastructure and secrets (not authorized by this doc)

After the identity check and approval, use a separate staging bot deployment,
durable database and nonproduction Discord guild with test-only accounts.
Do not reuse production `DATABASE_URL`, Discord token, guild, payment evidence
or worker secrets. Back up the isolated staging DB before approved migrations.

Website Worker names: `PAYMENT_API_SECRET` (staging bot/Worker shared bearer),
`PAYMENT_TOKEN_SECRET` (independent, Worker-only HMAC key),
`PAYMENT_WEBSITE_BASE_URL` (explicitly approved staging HTTPS origin).
Use independently generated high-entropy credentials at least 32 characters
in protected stores; length alone does not prove entropy. Never print,
commit or paste a value into issue/CI logs. Read-only secret-name and
flag-presence checks are permitted; actual rotation/revoke tests need
separate staging authorization. Token-key rotation invalidates
outstanding derived checkout URLs, so document an orderly drain/expiry
process and restore plan before rotation.

Bot names: `AVENTAS_CHECKOUT_ENABLED=false`,
`AVENTAS_CHECKOUT_RECONCILIATION_ENABLED=false`,
`AVENTAS_WEBSITE_BASE_URL`, `AVENTAS_PAYMENT_API_URL` (both approved staging
HTTPS **origins**, not API paths), and `AVENTAS_PAYMENT_API_SECRET` (same
staging bearer as Worker, never its token-signing key).
The older unprefixed bot env aliases are supported where documented, but
do not set conflicting pairs. `AVENTAS_SLICE_AUTO_APPROVAL_ENABLED` is
deprecated/inoperative; mail and screenshots cannot authorize a payment.
Keep GST collection and quoted-order legacy checkout paths disabled.

Staging checkout schema migrations `0001_checkout_sessions.sql`,
`0002_rate_limits.sql`, `0003_verification_uniqueness.sql` must be applied
only to the independently verified staging D1 after reviewed approval,
with schema/index inspection, backup, rollback plan and no production binding.
The bot's `checkout_verify_outbox` migration is **separate and opt-in**:
use only its reviewed SQLite *or* PostgreSQL SQL for the actual staging DB
engine; do not auto-migrate or flip the reconciliation flag on production.
Any future GST schema needs its own independent signed release gate.

## 4. Automated checks and synthetic staging acceptance

First require green exact-head and default-branch CI on Pay, website and bot
including CodeQL/static scans, dependency audits, full tests, typechecks,
vendor parity and the frontend build. Record exact commits and workflow URLs.

The website's approved `scripts/checkout-staging-acceptance.mjs --check`
is a **no-network** origin-shape preflight. Its `--run` writes two synthetic
staging rows and requires all of: a separately approved HTTPS staging hostname,
an independently verified staging Worker/D1, a staging-only bearer of at
least 32 characters, and `AVENTAS_CHECKOUT_STAGING_CONFIRM=SYNTHETIC_STAGING_ONLY`.
Run only with synthetic nonpayable test data and a protected staging secret,
never production credentials. Do not enable `workers.dev` or live customer
checkout simply to make the runner pass. Capture only redacted results.

With an independently isolated bot/Discord guild also test and archive:
create/replay/drifted amount/payee/buyer/product, exact post-wallet paise,
UPI QR `pa/am/cu`, expiry/cancel/verify races, wrong/revoked bearer,
unknown token, 409/429/5xx, restart/retry cap, receipt uniqueness,
NEEDS_REVIEW staff closure, failed website notification after locally
verified payment, manually reviewed transfer, single fulfillment and
manual UPI fallback when Worker or bot-hosted checkout is unreachable.
A synthetic `PAID` assertion in staging **is not real bank proof**.

## 5. Ops, privacy, tax and cutover approval

Before asking to enable checkout, the operator must attach evidence for
[Pay #15](https://github.com/Aventas-Org/Aventas-Pay/issues/15) and
[#16](https://github.com/Aventas-Org/Aventas-Pay/issues/16),
plus independently approved merchant bank receipt SOP, retained/reviewed
redacted reconciliation ledger, queue/incident alerts, refunds/disputes,
customer disclosure, screenshot retention/privacy, accessible mobile
checkout, rollback/restore drill, and finance/GST approval as applicable.
Keep each issue open until its own acceptance criteria are evidenced.

A production canary ([Pay #23](https://github.com/Aventas-Org/Aventas-Pay/issues/23))
needs explicit named payments/security/platform/ops sign-off, verified
live Worker/D1 bindings, production backup and recoverability proof,
reviewed rollout and rollback SHAs, on-call responders, scope/stop limits,
and real-time redacted monitoring. **Do not** infer this from green GitHub
Actions or a successful Railway bot deployment.

## 6. Safe rollback and customer response

First stop issuing new hosted checkout links through the approved flag
process; the existing manual UPI/order path stays available. Preserve
verified bot orders, queued notices, terminal D1 sessions, original receipt
evidence and backups. Do not drop tables, delete review rows, reset a
verified receipt, reprice an old order, rotate token keys mid-session, or
advise the customer to send money twice. Independently reconcile any
bot-VERIFIED / website-PENDING, CANCELLED or EXPIRED discrepancy before
closing the incident or initiating an approved refund.

Customer wording: **"If money was debited, please do not pay again while our
staff checks your order against the merchant account. Never share a UPI PIN
or OTP. An uploaded screenshot or checkout page state alone is not proof
that funds reached Aventas."**

All evidence should use synthetic IDs and redacted links; retain restricted
real receipt/PII records only in approved stores with access and retention
policies established by the payment/privacy owners.
