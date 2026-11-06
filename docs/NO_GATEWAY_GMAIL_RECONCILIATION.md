# No-gateway-fee UPI email reconciliation — staging integration

**Status:** code-only, optional staging integration. Not a production
collection system; does not use a payment gateway, pay a gateway transaction
fee, or activate the personal Slice savings account for commercial collection.

## What was built

1. A SQL-backed unique-amount proposal for integer-INR base prices:
   ₹480.00 can be proposed as ₹480.01…₹480.99. All competing workers use
   UNIQUE(recipient_key, amount_paise), not an in-memory set. An order replay
   returns the same proposal. Different UPI aliases leading to the same
   physical receiving account MUST use the same stable opaque recipient_key.
2. A bound, read-only Gmail API adapter accepting a server-side
   `gmail.readonly` OAuth access token and configured alert sender.
   It searches only a narrow time window, reads up to 50 messages, decodes
   MIME text, and passes the provider-issued Gmail API message ID to the
   existing amount-only parser. An email sender or Google login authenticates
   neither the bank credit nor ownership of the order.
3. A SQL-backed mailbox review receipt store. UNIQUE message-key digests
   reject repeat emails; changed content with the same provider message ID
   becomes a conflict. No raw body, sender, token, UTR or screenshot is
   written to the review table.
4. `syncGmailEvidenceToReviewQueue` is an injectable polling entrypoint.
   It can ingest a bounded batch and return a summary without ever
   invoking order/payment verification or fulfillment.

## Running the synthetic tests

From `website/`:

```sh
bun test test/sqlEmailReviewStore.test.ts test/gmailReadOnlyReview.test.ts
bun run typecheck
```

The additive `migrations/0004_email_review_reservations.sql` is **not**
included in the checkout startup migration list or vendor manifest and
**must not be applied automatically to existing staging/production D1**.
Its tests apply it in memory. No live Gmail credential or bank statement was
accessed by these tests.

## Security / financial boundaries

- Authentication to Gmail does not establish authenticated Slice bank
  settlement. Emails can be misleading, delayed, duplicated, edited or
  spoofed; the matching amount does not prove who paid.
- All ledger outcomes are staff-review evidence only, and return
  `paymentVerified=false`, `canFulfill=false`.
- This prototype reserves only 99 nonzero fractions per whole-rupee base
  for the same actual recipient. Reservations are **never reused**, even
  after cancellation, to prevent accidental late-payment ambiguity.
  Real capacity requires bank-confirmed late-payment aging and reviewed
  reservation lifecycle/reconciliation before any release.
- The proposed amount is NOT an authorized final price. Before displaying
  a payable QR, an authorized invoice/quote subsystem must bind the amount,
  recipient, order, discount and applicable taxes together, explicitly
  disclose the final amount to the buyer, and persist immutable facts.
- No automatic payment release, webhook, trusted bot verification call,
  browser callback approval, new flag, secret, D1 migration, or live route.
- Aventas must have a bank-approved business receiving arrangement. Current
  commercial collection on a personal Slice savings account is not
  assumed permitted merely because incorporation is pending.
- When/if a bank supplies an authenticated read-only credit status API
  at no per-transaction fee, it can be added as the *authoritative* step
  without changing this UPI checkout UX. The bank, not email, must confirm
  the actual credited merchant account, exact amount and unique transaction.

## Required installation inputs (not provided or requested in chat)

- Merchant/bank approval for business collections and the goods sold.
- App-specific Google OAuth with `gmail.readonly`, via a securely
  managed refresh/access token source and backend-only secret storage.
- A trusted stable recipient key for each actual receiving bank account
  and a protected authoritative order snapshot/reconciliation window.
- Security/operator sign-off before installing a scheduled staging poller,
  applying the migration or changing checkout enable flags.

Read [original evidence safeguards](EMAIL_REVIEW_INTAKE.md) and
[release gates](WORK_REMAINING_BLOCKED.md).
