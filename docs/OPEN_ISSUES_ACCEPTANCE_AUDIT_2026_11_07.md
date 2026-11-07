# Aventas Pay — open-issue acceptance audit (2026-11-07)

**Scope:** `Aventas-Org/Aventas-Pay` canonical source, default branch `main` at audit baseline `00eb64e537416d7a36e49eb38a3cd4fea79313c4`, and the 11 currently open GitHub issues. This is **not** a production release, financial sign-off, live settlement proof or claim that all issues are fixed.

**Default posture:** NO-GO for activating production hosted checkout, GST collection or email-based automatic settlement approval. Isolated staging uses synthetic records and a non-payable UPI recipient. No real funds, customer records, credentials, production migrations, financial flag changes or DNS cutover are authorized by this audit.

## Engineering result in the accompanying PR

- Canonical `website/src/handlers/verifySession.ts` now finds an already-PAID order **by order ID**, not only by the default idempotency key, before attempting any new payment transition. This closes an idempotent retry gap when an authenticated caller created the session with a permitted custom `idempotency_key`.
- The SQL-backed regression verifies initial payment acknowledgement, identical-reference replay (HTTP 200), mismatched-reference rejection (HTTP 409), single recorded verification, and a redacted terminal public view.
- Verification comments now explicitly require independent bank/PSP proof; a spoofable email or screenshot alone does not qualify.
- The deployed Aventas-website code **vendors** canonical Pay handlers; it needs a separate scoped website PR and parity/CI checks before this handler change can reach staging or production. This PR does not change the website, bot deployment, secrets or checkout enablement.

## Eleven separately tracked tasks

### 1. [#7 — release program](https://github.com/Aventas-Org/Aventas-Pay/issues/7)
**Observed:** program board and source-of-truth documents exist; some staging API/QR/rotation evidence is recorded on the issue. **Pending:** consolidate the exact approved releases across Pay, website and bot; have owner and finance/security sign the final acceptance matrix. **Evidence required:** exact reviewed SHAs, environment identity, outstanding P0 disposition and signed go/no-go decision. **Status:** OPEN — governance gate, not solved by code CI.

### 2. [#9 — isolated bot and persistent test database](https://github.com/Aventas-Org/Aventas-Pay/issues/9)
**Observed:** issue reports an isolated Railway test service with durable storage and a separate test guild. **Pending:** safe recovery of unpaid orders with stale Discord component IDs, staff-role verification and a controlled rollback exercise. **Evidence required:** synthetic orders across restart and rollback with persistent DB identity, no duplicate payment instructions or deliveries. **Status:** OPEN — live staging exercise required.

### 3. [#10 — payment secrets and origin trust](https://github.com/Aventas-Org/Aventas-Pay/issues/10)
**Observed:** issue records independent staging secrets, public staging endpoint tests and API credential rotation/revocation checks. **Pending:** operator-owned, redacted final configuration/prod-default-off attestations and source-to-deployed version parity. **Evidence required:** variable *names* and environment separations only (never values), fail-closed behavior and credential-rotation provenance. **Status:** OPEN until responsible security owner accepts the full matrix.

### 4. [#15 — synthetic end-to-end integration](https://github.com/Aventas-Org/Aventas-Pay/issues/15)
**Observed:** deployed API, expiry and key-rotation synthetic checks and hosted Discord QA are documented. **This PR:** repairs a canonical custom-idempotency-key verified-receipt replay gap and adds a real SQL regression. **Pending:** exercise deployed Worker/bot/outbox end-to-end, failures (401/403/404/409/429, 5xx, timeout), staff review, delivery, restart and recovery with synthetic orders. **Evidence required:** exact bot/Worker revisions, non-payable recipient, redacted transitions and reviewer results. **Status:** OPEN — regression tests alone are not the full deployed matrix.

### 5. [#16 — durable verification outbox](https://github.com/Aventas-Org/Aventas-Pay/issues/16)
**Observed:** guarded outbox implementation and retry-budget fixes are reported merged in Aventas-bot. **Pending:** controlled actual staging queue/migration, restart recovery, bounded retries, NEEDS_REVIEW closure and real staff reconciliation. **Evidence required:** isolated DB migration revision, queue/retry states and staff acknowledgements, without receipt strings in logs. **Status:** OPEN; do not enable production reconciliation flags.

### 6. [#17 — authoritative manual receipt review](https://github.com/Aventas-Org/Aventas-Pay/issues/17)
**Observed:** `docs/PAYMENT_OPERATIONS_RUNBOOK.md` already specifies bank/PSP independent checking and dual control for exceptions. **This PR:** removes a misleading code-comment implication that Slice email matching is settlement proof. **Pending:** designate the actual merchant/payments lead and second reviewer; test bank/order/amount/merchant/reference mapping and staff escalation with synthetic negative cases. **Evidence required:** adopted SOP and authorized role matrix. **Status:** OPEN; do not re-enable heuristic email auto-approval.

### 7. [#18 — optional verified PSP/bank adapter](https://github.com/Aventas-Org/Aventas-Pay/issues/18)
**Observed:** `docs/VERIFIED_PSP_SETTLEMENT_CONTRACT.md` is a **design-only** threat/security contract. **Pending:** merchant-approved provider, official signed-event specification, authenticated status/settlement source, webhook replay/nonce contract, refund and reversal semantics, sandbox evidence and separate implementation PR. **Evidence required:** provider contract and separate compliance/security sign-off. **Status:** OPEN; Track B is optional and must not block a properly approved manual-only Track A for the wrong reason.

### 8. [#19 — GST quote/payment/invoice binding](https://github.com/Aventas-Org/Aventas-Pay/issues/19)
**Observed:** the relevant tax quote, invoice and migration implementation is in Aventas-website, not this standalone Pay repository. **Pending:** immutable signed quote-to-checkout snapshot, replay/expiry and invoice/refund consistency tests, qualified tax review. **Evidence required:** website PR/CI and finance sign-off. **Status:** OPEN; leave GST disabled and do not invent tax rates or invoice authority.

### 9. [#20 — observability/reconciliation/incident response](https://github.com/Aventas-Org/Aventas-Pay/issues/20)
**Observed:** `docs/PAYMENT_OPERATIONS_RUNBOOK.md` proposes redacted events, support scripts, daily discrepancy review and rollback. **Pending:** actual alert routing and threshold delivery, 24-hour discrepancy ledger, refund/dispute workflow adoption, incident and rollback drills. **Evidence required:** sanitized staging run artifacts and named incident owner. **Status:** OPEN; proposed SLOs are not measured SLOs.

### 10. [#22 — privacy, retention, disclosures](https://github.com/Aventas-Org/Aventas-Pay/issues/22)
**Observed:** public projection avoids raw receipt/Discord identifiers; linked bot/website privacy fixes have CI evidence. **Pending:** merchant/legal-approved screenshot, support-ticket, buyer identifier and receipt-digest retention/deletion schedule; accurate policies, refunds/disputes and mobile/accessibility acceptance. **Evidence required:** approved policy text, access/hold handling and runtime QA. **Status:** OPEN; this audit sets no invented retention duration.

### 11. [#23 — controlled production launch](https://github.com/Aventas-Org/Aventas-Pay/issues/23)
**Observed:** no go-live approval follows from CI, staging-only payment instructions or this PR. **Pending:** signoff of applicable P0 gates, backup and tested restore/rollback, exact deployment SHAs, production fail-closed checks, authorized non-financial canary, staffed monitoring and after-launch reconciliation. **Evidence required:** separately approved release plan signed by CEO, payments, infra/security and relevant compliance owners. **Status:** OPEN; no production payments, migrations or enablement implied.

## CI and review gate for this PR

Run the existing `Checkout integration` and `Security analysis` workflows on the PR head. The checkout job runs Bun API tests with coverage and typecheck, Python bot/cross-system tests, frontend tests/typecheck/build, Bandit, Python dependency auditing and both `bun audit` checks. Security analysis runs CodeQL for JavaScript/TypeScript and Python. Treat pending, skipped or failed checks as **not green**; record the exact head SHA and job links. These checks do not substitute for isolated staging, independent settlement proof, or legally authorized production operations.

**Integration rule:** do not merge this PR or copy its handler into Aventas-website until manual code review and the website vendoring/parity follow-up are complete. Do not close any of the 11 issues until its individual acceptance evidence is linked and accepted by the responsible owner.
