# Aventas Pay — production-equivalent Track A QA audit

**Audit date: 2026-11-10. Release decision: NO-GO for new hosted real-money checkout.**

Scope: [program #7](https://github.com/Aventas-Org/Aventas-Pay/issues/7), manual bank-verified UPI sales. Separately authenticated PSP/bank settlement (#18) is not planned for this release; a Gmail sender, screenshot, UTR or decimal amount does not independently establish credited merchant funds.

This is a completed **read-only source, CI, schema, platform and release-evidence audit**, NOT a completed payment-operations acceptance run or a production release authorization.

## 1. Reviewed exact source and CI

| Repository | Reviewed main SHA | Latest relevant verified checks |
| --- | --- | --- |
| Aventas-Pay | a5d7f984ee9a576d216619c1ccd14d36d92c5780 | [Checkout CI PASS](https://github.com/Aventas-Org/Aventas-Pay/actions/runs/42433073714); [CodeQL PASS](https://github.com/Aventas-Org/Aventas-Pay/actions/runs/42629645733) |
| Aventas-website | 5de601297d129e9d459ec76d58bcbc4c5fac3964 | [Full CI PASS](https://github.com/Aventas-Org/Aventas-website/actions/runs/42442652918); [static security PASS](https://github.com/Aventas-Org/Aventas-website/actions/runs/42634364373); [dependency security PASS](https://github.com/Aventas-Org/Aventas-website/actions/runs/42633100480) |
| Aventas-bot | 896b6b5da8d0ed215ef179b83349635546861dcc | [Bot CI PASS](https://github.com/Aventas-Org/Aventas-bot/actions/runs/42398348911); [dependency security PASS](https://github.com/Aventas-Org/Aventas-bot/actions/runs/42633503561) |

[Website PR #186](https://github.com/Aventas-Org/Aventas-website/pull/186) **is merged**. Its canonical Pay vendor parity and checkout terminal-state tests passed. A source-code merge does not establish deployment parity or merchant settlement.

## 2. Independent live read-only resource inventory

Checked with connected Cloudflare/Railway APIs on November 10. No passwords, raw receipt references, customer records, variable values, live funds, migrations, deployments, environment toggles or runtime restarts were accessed or changed.

| Resource | Independently observed | Verdict |
| --- | --- | --- |
| Production Cloudflare Worker | aventas, deployment 9e1f0298-cbe8-432f-a0e9-4f7ab258ad9d, version 63dc9fee-8064-446d-9084-d5a926ec24a9, 2026-11-08 03:25 UTC; D1 aventas-db (170a4050-49c3-49ad-a08d-7c07cc0e38d9); **no PAYMENT_API_SECRET or PAYMENT_TOKEN_SECRET bindings** | Production payment bearer absent by name; full application/HTTP fail-closed behavior not established by settings alone |
| Staging Cloudflare Worker | aventas-staging, last deployment c3271465-f91b-4222-8c4f-af7f8631ea5b, 2026-11-07 04:44 UTC; D1 aventas-staging-db (9e298657-2d0f-4dcc-818d-9435386c3050); distinct protected payment secret bindings present | D1 identity isolation PASS. Staging deployed revision predates website PR #186: runtime checkout parity BLOCKED |
| Staging D1 schema | checkout_sessions, checkout_session_events, checkout_rate_limits; UNIQUE provider-reference, token-hash and idempotency attempt indexes; migration ledger 0001, 0002, 0003 checkout and 0004, 0005 synthetic/decimal | Schema and uniqueness baseline PASS, not a payment or settlement test |
| Railway staging test bot | aventas-pay-test-bot ONLINE with persistent /data; deployed source f045d591cd9782413ff9d200d461e967f1835476 | Older than bot main 896b6b5…; no current-revision staff/outbox/rollback acceptance |
| Railway staging Gmail review | aventas-gmail-review-staging ONLINE with independent persistent /data; source 00eb64e537416d7a36e49eb38a3cd4fea79313c4 | Older than Pay main a5d7f98…; email review is not a bank settlement oracle |
| Feature flags | Railway variable **names** exist for hosted checkout, reconciliation and Slice-auto-approval; secret/flag **values were not read** | Cannot claim flags are enabled or disabled from name inventory |

Earlier synthetic [#15](https://github.com/Aventas-Org/Aventas-Pay/issues/15) acceptance records direct API cases and expiry/secret rotation but do not cover the final merged revisions or complete Discord staff and outbox end-to-end flows. A fresh public HTTP smoke test of the staging hostname could not be completed through this session's browser interface; do not mark one PASS.

## 3. Full release QA matrix

The machine-readable release evidence is at [docs/release/track-a-qa-evidence-2026-11-10.json](release/track-a-qa-evidence-2026-11-10.json).

**Results: 4 of 13 gates PASS, 9 BLOCKED, 5 named-role approvals PENDING.**

| Gate | Result | Remaining exact acceptance |
| --- | --- | --- |
| All three source main CI/security workflows | PASS (source only) | Fresh rerun if revisions move |
| Canonical Pay to website source parity | PASS | #186 merged, full website CI green |
| Cloudflare stage/production D1 separation | PASS (inventory) | Independently different identities |
| Staging checkout schema/migration/index integrity | PASS (schema) | Constraints verified read-only |
| Staged deployed revision parity | BLOCKED | Match actual Worker, bot and Gmail review code to reviewed SHAs; #15 |
| Discord isolated-guild roles, durable order and restart | BLOCKED | Staff permission review, recovery from stale UI and rollback drill; #9 |
| Deployed synthetic checkout API/QR/negative E2E | BLOCKED | 400/401/403/404/409/429, expiry within 120 seconds, cancellation, paid replay, exact INR/VPA/QR, tampering, timeouts and 5xx, manual fallback and single delivery; #15 |
| Bot outbox and reconciliation resilience | BLOCKED | Explicit staging migration, OFF guard, idempotent enqueue, 12-tries/two-hour holds, 401/403/404/409 review, restart and NEEDS_REVIEW staff closure; #16 |
| Independent merchant bank/PSP funds review | BLOCKED | Authorized staff review real merchant credited status, exact amount/order/payee/ref/time, exception second reviewer; #17 |
| Privacy, refunds, support and mobile accessibility | BLOCKED | Merchant-approved retention/deletion, policies, dispute SOP, refund staff workflow, support tickets, screen-reader/mobile tests; #22 |
| Non-GST invoice policy or separately approved GST snapshot | BLOCKED | Prove legal GST-disabled sale/customer invoice handling or obtain qualified tax review of signed quote-to-payment-to-invoice; #19 |
| Monitored alerts, discrepancy ledger, incident/rollback | BLOCKED | Staff receives test alerts, 24h discrepancy handling, outage response, backup restore and rollback; #20 |
| Signed production canary | BLOCKED | CEO/payments/security/ops approval, exact deployed SHAs, known-good rollback, fail-closed runtime smoke and staffed canary; #23 |

**A test-only PAID row in staging must never be interpreted as independently verified real funds.**

## 4. Actionable release path

1. **Infra + QA:** separately approve a nonproduction rollout of current-reviewed website Worker and test bot; confirm source versions, staging D1, independent bot DB, test-guild identity and secret/flag values through protected operator access without exposing them.
2. **QA + payments:** execute website's guarded synthetic staging acceptance runner and the Discord bot staff test matrix. Do not use an actual payable merchant VPA or send money. Capture redacted test outcomes, HTTP codes, D1 status counts, role matrix and deployment identities.
3. **Bot/ops:** explicitly validate the isolated reconciliation outbox schema, transactional receipt durability, retries, restart, review queue and delivery exactly once; demonstrate manual UPI fallback during Worker outage and after token expiry.
4. **Payments/legal:** adopt independent bank-based verification; rehearse dispute, refund, duplicate debit and no-repay customer handling; approve privacy retention and non-GST/GST-disabled invoice policy. Never use email-only auto PAID.
5. **Owner/security/ops:** test alert delivery, rollback and restore without deleting sessions or double charging; approve a separate signed production release and monitored canary only after applicable gates pass.

## 5. Automated fail-closed safeguard added

The release-evidence auditor is **offline, read-only and incapable of enabling checkout**.

- Run: node --test qa/release-gate.test.mjs
- Summary: node qa/release-gate.mjs docs/release/track-a-qa-evidence-2026-11-10.json
- Strict operator review gate: node qa/release-gate.mjs --assert-review-eligible docs/release/track-a-qa-evidence-2026-11-10.json

The strict command intentionally returns nonzero while gates/approvals are incomplete. Even complete evidence produces **AWAITING SEPARATE SIGNED PRODUCTION RELEASE**, never automatic GO. New CI runs must publish the NO-GO decision without treating green unit tests as money or operations approval.

**Issue #7 closure rule:** only after verified runtime QA on approved deployed revisions, role-specific operational/legal/payments signoffs, a documented reversible production release and explicit owner authorization. Until that evidence exists, #7 must remain OPEN.
