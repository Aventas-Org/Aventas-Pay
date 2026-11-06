# Razorpay webhook authentication — sandbox-only primitive

**Status: unconnected security helper, not a deployed webhook, payment API
client, active payment method or authority to fulfill orders.** See
[PSP/Bank contract](VERIFIED_PSP_SETTLEMENT_CONTRACT.md).

Aventas is considering the **individual / unregistered business** onboarding
route while awaiting incorporation. Razorpay's published onboarding information
allows eligible applicants to apply; activation is conditional on verification
and approval. This is NOT an assertion that Aventas' products or the current
personal Slice savings account will be accepted.

## Exact scope

`website/src/services/payment/razorpayWebhookReview.ts` provides:

- HMAC-SHA256 verification over **raw original bytes** using a distinct
  webhook signing secret, with constant-time signature comparison.
- Shape checking for `payment.captured` snapshots and trusted immutable
  `razorpayOrderId` + integer INR paise + pending status. Rejects wrong amount,
  currency/order, malformed data, uncaptured/refunded/terminal states.
- **Always** returns `NEEDS_REVIEW`, `paymentVerified=false`,
  `canFulfill=false`, even after a cryptographically correct signature.
- No network access, bot/checkout import, migrations, secrets, payment event
  writes, receipt IDs, customer screenshots or UTR parsing.

**Why not fulfill on a signed webhook?** A webhook signature authenticates
Razorpay's delivery under the locally configured secret, not Aventas'
merchant eligibility, the correct bank beneficiary, durable idempotency,
refund/dispute status or whether an independently fetched payment remains
captured. Event delivery may be duplicated or out of order.

## Work remaining before merchant-approved activation

1. Obtain written processor/category approval for Aventas' actual goods,
   including any game-credit resale, and an acceptable settlement account.
   If products are Riot virtual content, independently verify resale/licensing
   authorization with Riot; do not mislabel product descriptions.
2. Open a **test-mode** Razorpay merchant environment using genuine KYC and
   product information. Store separate API/webhook credentials as managed
   secrets, never inside GitHub, browser, logs or chat.
3. Add server-authenticated Razorpay Orders creation from the immutable
   post-discount/post-wallet/tax quote, storing a permanent 1:1 mapping of
   Aventas order, Razorpay order, amount, merchant and authorized fulfillment.
   No ad hoc decimal uplift after quote acceptance.
4. Add a real HTTP webhook endpoint with byte-accurate signature verification
   *before* JSON parsing; build a transactional, database-unique event inbox
   and payment ledger. Acknowledge only after durable receipt.
5. Fetch payment status through the Razorpay API with server-side merchant
   credentials; require correct captured state, amount, currency, order and
   merchant account before marking PAID. Handle late, duplicate and refunded
   events without double fulfillment.
6. Integrate with the bot's idempotent notification and delivery outbox.
   Prove runtime staging tests for valid, forged, replayed, wrong order,
   wrong merchant, cancelled, refunded, failed status and partial payment,
   plus restart/outage/rollback and support/refund escalation.
7. Obtain payments, security, finance and consumer-disclosure approval before
   turning on any live commercial checkout. Keep the existing personal Slice
   UPI collection route OFF for the commercial automated flow.

This helper is intentionally isolated until merchant eligibility, provider
selection, settlement terms and staging are approved. It avoids adding an
unsafe shortcut that can automatically deliver unpaid goods.
