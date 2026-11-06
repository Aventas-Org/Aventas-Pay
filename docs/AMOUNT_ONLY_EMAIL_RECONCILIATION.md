# Amount-only email reconciliation — offline proof-of-concept

**Status: review-only. Not deployed, not connected to Gmail/IMAP, not a
payment provider integration, and not authorized to approve or fulfill orders.**
This is a customer-experience experiment under the existing fail-closed
Track A/manual and Track B/verified-provider separation.

## Proposed customer experience

1. An authorized merchant creates an order and obtains the customer's explicit
   agreement to its final payable amount, including any fractional difference
   and its tax treatment **before** displaying a QR code. Never silently add
   ₹0.24 after an order/quote/invoice has already been persisted.
2. Where legally and operationally supported, the checkout can show a unique
   amount such as ₹480.24. The amount and beneficiary must be snapshotted
   identically in the bot order, signed quote, checkout session and QR payload.
   The current code does **not** perform this step.
3. An authenticated inbox reader can extract a claimed INR amount for a
   staff-facing reconciliation suggestion. Mailbox OAuth/IMAP authentication,
   SPF, DKIM, DMARC, From and exact amount matching only establish properties
   of an email, **not receipt of funds**. The current parser is an offline
   pure function and performs no inbox access.
4. Avenues for independently verifying bank/PSP payment status, merchant
   account, actual credited amount, immutable order, and any refunds or
   reversals are described in
   [VERIFIED_PSP_SETTLEMENT_CONTRACT.md](VERIFIED_PSP_SETTLEMENT_CONTRACT.md).
   Only an explicitly integrated and approved provider may authorize a
   future automated transition; no email can call the trusted verify route.
5. On missing/ambiguous/late/reused amounts, bank uncertainty or provider
   outage, retain PENDING/NEEDS_REVIEW and escalate to authorized staff.
   Never instruct a debited customer to pay again solely due to timeout.

## Constraints for any future decimal reservation system

- The optional `suggestUnusedFractionalAmountPaise()` function is **not** a
  reservation service: it is pure, selects the first unoccupied paise value
  (01–99) for a positive whole-rupee input, and returns null when exhausted.
  It cannot prevent concurrent allocations or prove a payment.
- Production must atomically reserve amounts for a merchant+currency and an
  appropriate unresolved-payment/reconciliation window. Enforce database
  uniqueness and retry transactional conflicts; include previously paid,
  expired, cancelled and late-paid orders until fully reconciled.
- There are only 99 nonzero fractional values per whole-rupee price under
  this prototype. At high concurrency, exact-amount allocation can exhaust
  quickly. A duplicate amount is a review conflict, not proof of either order.
- Verify each supported UPI application's behavior with the provider; users
  may alter a UPI amount or send split, partial or rounded payments. Amount-only
  email text cannot bind payer identity or order ownership.
- Decimal pricing must comply with accepted checkout totals, GST/tax,
  wallet application, consumer disclosure and invoice snapshot requirements.
  All additions/adjustments must be explicitly approved and accounted for;
  no amount mutation is allowed after the immutable payment snapshot.
- Do not re-enable `AVENTAS_SLICE_AUTO_APPROVAL_ENABLED`, create a fake PSP
  webhook, or connect the owner's personal Slice savings account for business
  collection. Use an approved business/merchant account and independently
  authenticated bank/PSP settlement records.

## Safety acceptance for this limited change

- Email parsing yields integer paise or null, never an RRN/UTR or payment proof.
- Email matching produces at most a **review candidate**; its result always
  has `paymentVerified=false`, `canFulfill=false`.
- Missing, conflicting, repeated, previously settled and terminal-order
  amounts cannot authorize payment.
- The new suggestion helpers are not imported by checkout or bot handlers.
  Hosted checkout and Slice email auto-approval remain default off.
- Separate Track B implementation and staging acceptance are required for
  automatic approval. See [release gates](WORK_REMAINING_BLOCKED.md).
