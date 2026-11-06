# Email-only evidence intake (draft, not live collection)

This stage is **offline and review-only**. It supports the proposed
screenshot-free, UTR-free customer experience without mistaking a mailbox alert
for an authenticated bank settlement. It cannot turn on Aventas Pay or verify
a customer's payment.

## Components

- `emailEvidenceParser.ts` extracts one nonconflicting INR amount into
  integer paise. No UTR/RRN extraction.
- `amountOnlyReview.ts` produces a tentative amount-to-order candidate. A
  duplicate amount, cancelled/expired/paid order or ambiguous email never
  qualifies as a unique pending candidate.
- `emailReviewIntake.ts` stages a message for *human review*, based on an
  operator-approved mailbox connection ID and provider-issued **API message
  ID** (not an untrusted `Message-ID` email header). SHA-256 digests
  identify repeats and altered-content conflicts. Raw email and bank
  references are not returned or logged. It is a pure function; no network,
  inbox, database or PAID-transition code is connected.

`EmailReviewReceipt` is deliberately not a proof of payment. A future
persistent review queue must use an atomic unique index for its hashed
message key, restrict access, retain only necessary evidence, implement
time-bounded polling/retries, and record an operator audit trail.

## Production trust boundary

A customer can pay the displayed amount without uploading a screenshot.
Email amount matching can help staff find a possible order, but cannot
establish that funds settled in Aventas' account. An approved merchant
bank/PSP record (or direct review of the account by authorized staff)
must independently confirm money, recipient, order amount and unique credit.
The legacy Slice automatic mail approval path must stay disabled.

Do **not** add ₹0.24 after a quote is accepted. Fractional amounts need
legal/tax approval, exact persistent quotes, an atomic reservation ledger
and no collisions for late/expired payments. For each whole-rupee amount
there are only 99 nonzero fractional values in the existing suggestion
prototype.

**Release gate:** the currently designated Slice personal savings account
is not approved as a commercial receiving account under its terms. Aventas
business registration status does not waive bank product terms or RBI
KYC/payment obligations. Require a provider/bank-approved collection
arrangement for the product category and complete staging safety tests before
live checkout, then separately approve automatic provider settlement.

See [provider settlement contract](VERIFIED_PSP_SETTLEMENT_CONTRACT.md)
and [staging gates](WORK_REMAINING_BLOCKED.md).
