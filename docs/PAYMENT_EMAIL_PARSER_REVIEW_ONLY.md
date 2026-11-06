# Payment email parser branch — safe extraction scope

**READ-ONLY / REVIEW REQUIRED. Not a payment verifier.**

The historical `feature/payment-email-parser` root commit was created with
**no shared Git history with main**, so GitHub's ordinary compare returned
`No common ancestor`. The original branch includes an unrelated application
tree and a legacy Gmail/IMAP worker that:
- calls `tls.connect(..., { rejectUnauthorized: false })`;
- treats the email sender, body and self-reported DKIM/SPF header as settlement proof;
- matches orders by amount/time and can transition an order to `SUCCESS`;
- logs raw transaction references and email parsing exceptions.

**None of those worker, database, UI, settlement, or credential behaviors are
part of this PR.** Do not deploy or merge the original root tree as a checkout
implementation. This PR reapplies only safe, synthetic offline parsing onto
the up-to-date canonical checkout tree, retaining the historical root commit
in the feature branch as a non-executable ancestor for provenance.

`website/src/services/payment/emailEvidenceParser.ts` is a **pure,
unreferenced utility**. It never contacts Gmail/IMAP, verifies a payment,
writes a database, sends a notification, calls a trusted verification
endpoint, processes a refund or fulfills an order. Every result is
`NEEDS_REVIEW` with `paymentVerified=false` and `canFulfill=false`.

Only a parsed amount in integer paise is **untrusted customer-support
evidence**. The amount-only parser does not extract, return, or match UTR/RRN
transaction references. An offline amount correlation helper can suggest a
single candidate order for staff review, but never changes order or funds state. Even claimed DKIM/SPF/DMARC pass, a known
sender or exact amount match cannot confirm receipt into Aventas' merchant
account. Conflicting amounts and invalid inputs produce safe
reason codes. No user email body or transaction reference is logged.

**Operational rule:** an authorized staff member must independently verify
the actual merchant bank/PSP credit, beneficiary, immutable order amount,
currency, payer/order association, receipt uniqueness and refund/chargeback
state before using the existing trusted-verifier flow. Preserve the
default-off checkout/email auto-approval and existing manual fallback.

**Test gate:** `cd website && bun test --coverage && bun run typecheck`;
full Checkout integration, Python bot, frontend, dependency advisories,
and JS/Python CodeQL CI must pass on the exact PR commit. No staging
verification, legal approval or Track-B authenticated PSP integration is
claimed by this read-only parser.

## Optional decimal-amount concept (offline only)

`amountOnlyReview.ts` includes a pure, unconnected suggestion function for
whole-rupee bases (e.g. ₹480.00 → ₹480.01–₹480.99) and an amount-only
candidate matcher. Neither function is wired into checkout, order pricing,
email polling, bank authentication, bot approval or any payment state change.

Read [AMOUNT_ONLY_EMAIL_RECONCILIATION.md](AMOUNT_ONLY_EMAIL_RECONCILIATION.md)
before any merchant-reviewed implementation. Automatic approval requires an
independently authenticated provider/bank payment record; mailbox OAuth, sender
authentication and a matching decimal amount are not substitutes.
