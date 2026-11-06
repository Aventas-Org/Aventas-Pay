# Aventas Pay — complete product plan, threat model, and release QA (2026-11-06)

**Status:** release candidate, **not approved for production checkout activation**. The cross-repository launch board is [issue #7](https://github.com/Aventas-Org/Aventas-Pay/issues/7), with individually scoped issues [#8–#23](https://github.com/Aventas-Org/Aventas-Pay/issues). This document is a plan, not a claim that infrastructure or payments have been independently validated.

## 1. Product definition and release tracks

Aventas Pay is an Aventas-branded **hosted UPI payment-instruction and order-status product**. It currently bridges the Discord sales bot (order truth and human-approved fulfillment) to Cloudflare Worker/D1 session records and a customer page. It does **not** currently process/capture bank transactions itself. A screenshot, email sender, customer-entered UTR, QR scan, button click, or public status request is not trusted evidence that funds were received.

Two non-interchangeable releases:
- **Track A — human-verified hosted UPI**, contingent on verified real staging, independent staff review of merchant account, truthful customer messaging, safe manual fallback, durable notification reconciliation, merchant/finance/infra approval. This track can be rolled out without pretending email proves settlement.
- **Track B — independently authenticated PSP/bank automated settlement**, only after a merchant contract and separate implementation of trusted signed events, replay protection, amount/order/payee mapping, refunds/disputes/settlement reconciliation, risk & legal controls. Track B must never be enabled merely by flipping `AVENTAS_SLICE_AUTO_APPROVAL_ENABLED`.

**Track B design-only contract:** [Authenticated PSP/bank webhook and settlement adapter specification](VERIFIED_PSP_SETTLEMENT_CONTRACT.md). It deliberately adds no provider endpoint, credentials or launch switch. Provider selection, signing implementation, sandbox acceptance and merchant/compliance sign-off remain blocked under #18.

### Trust boundaries and source of truth

| Component | Allowed | Not allowed |
| --- | --- | --- |
| Discord bot | Persists order, amount after wallet deduction, selected UPI recipient, staff verification and fulfillment | Customer screenshots or spoofable email alone cannot mark verified; no duplicate receipt approval |
| Pay core | Creates and reads expiring sessions, enforces immutable payment facts, idempotency, unique verified receipts | Cannot assert bank settlement or price from browser |
| Website Worker/D1 | Serve minimal token-gated session projection, hardened authenticated create/cancel/verify, mark PAID on authenticated trusted bot signal | No public PAID transition, no live repricing, no storing raw payment screenshots in checkout |
| Browser checkout | Displays exact stored amount/UPI deep link when session is current and internally consistent | No payment initiation when status stale, terminal or QR mismatched; no “bank took no money” promises |
| Payment operator | Independently reconcile actual funds and approve manual payment/refund | No unverifiable automatic approval from unauthenticated merchant email |
| GST/invoice subsystem | Quote preview and persisted signed finance facts behind separate gate | No GST-collecting production checkout or invoice based on current tax-rate recalculation |

## 2. Priority release map

| Phase | Ticket(s) | Acceptance gate and accountable role |
| --- | --- | --- |
| M0: cloud and bot staging inventory | [#8](https://github.com/Aventas-Org/Aventas-Pay/issues/8), [#9](https://github.com/Aventas-Org/Aventas-Pay/issues/9), [#10](https://github.com/Aventas-Org/Aventas-Pay/issues/10) | Infra/security: independently identify approved staging-only Worker/D1, bot DB/guild, secrets and hostname. Never provision duplicate reported resources |
| M1: security and code integrity | [#11](https://github.com/Aventas-Org/Aventas-Pay/issues/11), [#13](https://github.com/Aventas-Org/Aventas-Pay/issues/13), [#14](https://github.com/Aventas-Org/Aventas-Pay/issues/14) | Security/engineering: scrub arbitrary log errors, prevent poisoned checkout origins, prove canonical vs website vendor parity |
| M1: customer experience | [#12](https://github.com/Aventas-Org/Aventas-Pay/issues/12) | Product/QA: do not encourage duplicate transfers after outage, expiry, cancellation or mismatched QR; accessible checkout |
| M1: release engineering | [#21](https://github.com/Aventas-Org/Aventas-Pay/issues/21) | Security/QA: lockfile audits, static checks, negative tests, reproducible CI and explicit advisory waivers |
| M3: synthetic staged E2E | [#15](https://github.com/Aventas-Org/Aventas-Pay/issues/15), [#16](https://github.com/Aventas-Org/Aventas-Pay/issues/16) | QA/payments: API + Worker/D1 + Discord bot and persistent outbox acceptance with fake funds and redacted artifacts |
| M4: financial authority and ops | [#17](https://github.com/Aventas-Org/Aventas-Pay/issues/17), [#19](https://github.com/Aventas-Org/Aventas-Pay/issues/19), [#20](https://github.com/Aventas-Org/Aventas-Pay/issues/20), [#22](https://github.com/Aventas-Org/Aventas-Pay/issues/22) | Payments/compliance/support: bank-based manual verification, GST gate, refund/incident runbook, privacy and retention |
| M5: controlled cutover | [#23](https://github.com/Aventas-Org/Aventas-Pay/issues/23) | CEO/payment owner/infra/security: signed go/no-go, production restore/rollback evidence, observed canary; no unapproved financial changes |
| M6: automated funds verification | [#18](https://github.com/Aventas-Org/Aventas-Pay/issues/18) | Independent provider contract, signature validation, idempotent received-funds and reversal rules — separate security-reviewed launch |

No invented human assignees: accountable *roles* above require designated operators, access approvals and evidence URLs at execution time.

## 3. Existing implemented baseline (code only)

- Aventas Pay PRs [#3](https://github.com/Aventas-Org/Aventas-Pay/pull/3), [#5](https://github.com/Aventas-Org/Aventas-Pay/pull/5), [#6](https://github.com/Aventas-Org/Aventas-Pay/pull/6) and website PRs [#151](https://github.com/Aventas-Org/Aventas-website/pull/151)–[#153](https://github.com/Aventas-Org/Aventas-website/pull/153) fix immutable replay facts, terminal states and paid-order atomic insertion.
- Aventas-bot PR [#34](https://github.com/Aventas-Org/Aventas-bot/pull/34) implements **opt-in**, separately migrated durable notification outbox. It is code merged but not proof of a staging DB migration or enabled reconciliation.
- Aventas-bot PR [#35](https://github.com/Aventas-Org/Aventas-bot/pull/35) blocks spoofable Slice email automatic approval **by default**. Human verifier must check bank receipt evidence independently.
- Website PR [#152](https://github.com/Aventas-Org/Aventas-website/pull/152) adds a guarded synthetic staging acceptance runner; it has **not** proved live Cloudflare staging availability.
- Prior Railway inventory showed a bot deployment online and a mounted `/data` volume, but no verified isolated staging environment/checkout config. Re-inventory against the current production deployment before relying on these observations.

## 4. Release test matrix — proof required, not just code assertions

For every case record test ID, exact code revision, environment, status, date, redacted DB evidence, pass/fail and QA reviewer.

### A. Sessions, money, tampering
- [ ] Synthetic bot order from persisted product + selected post-wallet payable amount produces one session with exact INR paise, merchant VPA and display name. No frontend-controlled inputs change financial facts.
- [ ] Bot retries return same token, URL and persisted facts. Changed amount, product, buyer, VPA or payment profile give HTTP 409. Concurrent changed-fact races and paid-order reopens fail atomically.
- [ ] Exactly one verified provider reference cannot pay multiple orders; same verified reference replay is safe, different reference fails.
- [ ] Expiry, cancellation and concurrent verify are terminal; late payments require independent merchant reconciliation, never a UI bypass.
- [ ] Payment instructions and QR URI encode exactly stored pa/am/cu/tn; malformed/mismatched, stale, expired, cancelled and unverified states show **no actionable payment destination**.

### B. Authentication, input, privacy
- [ ] Missing/wrong/revoked bot bearer returns 401 for create/cancel/verify, with no mutating DB call.
- [ ] GET status uses shape-checked 256-bit token, response allowlist and generic 404 for missing; no token, ID, VPA in logs unless VPA is explicitly the public instruction field.
- [ ] Content size and field validation reject crafted bodies, Unicode edge cases, injection, duplicate/invalid headers, and unsafe redirect/origin values.
- [ ] D1 rate limits are shared across simulated Worker invocations; high request loads return 429 rather than bypassing limits.
- [ ] Worker and bot logs contain no raw receipt email headers, UPI screenshots, checkout token, payment API secret, Discord user IDs or free-form exception strings.

### C. Bot and resilience
- [ ] Controlled staff approval verifies a genuinely matched test merchant record, but customer upload, fake screenshot or spoofed email alone never creates PAID.
- [ ] Trusted verified order plus temporary Worker outage leaves bot payment/fulfillment intact and durable notification queued *in the same DB transaction*.
- [ ] Bot restart drains same opaque receipt reference, retries bounded by deadline, and moves 401/403/404/409 or exhaustion to NEEDS_REVIEW rather than silently dropping.
- [ ] Reconciliation is OFF by default, no SQL reads/writes while OFF, explicitly reviewed isolated migration before it is ever ON.
- [ ] Manual UPI/QR/ticket/support/fulfillment still work while hosted checkout disabled, website unavailable, or token expired.

### D. Finance and product
- [ ] Staff resolve discrepant statuses against independently verified bank/PSP ledger; no page copy implies transfer success from local browser state.
- [ ] Process a synthetic cancellation, refund request, overpayment, underpayment and duplicate transfer with audited approval, notification and support handoff.
- [ ] Tax master, place-of-supply and quote integrity reviewed with qualified GST operator; invoice draws only from persisted quote-bound payment snapshot (separate release).
- [ ] Mobile/desktop, accessibility, Safari/Android, clipboard, screenreader and reduced motion work for all session states. Fraud/UPI PIN/OTP warnings and support path remain visible.

### E. Runtime and rollback
- [ ] Independently confirm staging Worker/D1 and staging bot DB physically isolated from production; record IDs without secrets; use only operator-approved HTTPS staging origin, not workers.dev.
- [ ] Record staging DB migration ledger, backups, Worker deploy SHA, HTTPS test hostname, bot version and Discord test guild. Never create duplicate staging resources without inventory.
- [ ] Run website `node scripts/checkout-staging-acceptance.mjs --check` offline, then `--run` only with staging-only credentials and explicit operator authorization. Verify bot E2E separately.
- [ ] Record API 5xx/401/409/429 alerts, stuck session/outbox counts, support contacts, incident comms and rollback trigger.
- [ ] Rehearse flag-off rollback without deleting sessions, changing token secret or reclassifying bot-verified funds; confirm all customer messages are safe after rollback.

## 5. Release policy and objective gates

**NO-GO if any:** unverified Cloudflare D1/Worker identity; staging/prod data overlap; missing test bot/guild isolation; unproven idempotency/replay/merchant destination; untrusted customer state can cause PAID; logs leak token or evidence; public page advises duplicate payments; wrong/manual bank verification; pending P0 CI failures; missing reconciliation/incident SOP; unsigned GST release; unavailable backup or rollout rollback evidence.

**Code may merge before staging sign-off only when** reviewed as nonactivating, migrations not applied, financial flags remain false, and main-branch automatic deployment impact has been assessed. Production launch itself requires a separately approved operator release record with signatories, real SHA/deployment IDs, staging test report, incident/rollback contacts, and canary criteria.

**Do not announce “bank settlement proven”, “production ready” or “payments live” from mocked tests, a green pipeline, or a successful Worker 200 alone.**

## 6. Owners, cadence and evidence template

Work in severity order: P0 security/data loss/correctness and staging setup first, P1 accessibility/operational maturity and automation design next. Each pull request should link a ticket, include affected repositories, test commands, expected/observed result counts and a risk/rollback section. Run canonical Pay CI, website CI and bot CI for all changes that affect cross-system behavior. Merge only after review; verify staged behavior independently before flags change.

### Per-issue proof block

```text
Ticket / owner role:
Affected SHA + PR + CI URL:
Environment (staging only; no credentials):
Reproduction / test fixtures:
Commands and observed pass/fail counts:
Negative security cases:
D1/DB/Worker deployment identity (redacted):
QA reviewer / payment reviewer / date:
Roll-forward and rollback drill:
Decision: PASS / FAIL / BLOCKED (reason)
```

Original operational context: [Pay release gates](WORK_REMAINING_BLOCKED.md), [Pay deployment checklist](DEPLOYMENT_CHECKLIST.md), [website staging runner](https://github.com/Aventas-Org/Aventas-website/blob/main/docs/checkout-staging-acceptance.md), and [bot reconciliation rollout](https://github.com/Aventas-Org/Aventas-bot/blob/main/docs/checkout-reconciliation-rollout.md).
