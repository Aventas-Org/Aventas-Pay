# Authenticated PSP/bank settlement adapter — security design contract

**Status: DESIGN-ONLY / NOT IMPLEMENTED / NO AUTOMATED PAYMENTS AUTHORIZED.**
This is the engineering specification for Pay [#18](https://github.com/Aventas-Org/Aventas-Pay/issues/18),
separate from Track A human-verified UPI checkout. It does not create a webhook
endpoint, provider account, API key, database migration, signature verifier,
refund processor, or permission to enable checkout or GST. Do not install a
generic webhook handler and assume it validates a specific provider.

## 1. Trust, financial authority and non-negotiable boundaries

Customer-controlled redirects, QR scans, client `success` flags, UTRs, proof
screenshots and emails are **never** authority that Aventas received money.
A valid webhook signature proves only that the payload was issued by a
configured provider principal; **it does not, by itself, prove settlement**.
Which signed state means paid/captured/settled, which merchant account received
it, and when fulfillment is allowed require signed provider documentation,
independent merchant reconciliation and payments approval.

The existing bot is authoritative for order snapshot, staff verification and
fulfillment in Track A; the website is the session/status projection. Track B
must introduce its own *explicitly reviewed* verified-provider authority, not
call the existing `/api/payments/checkout-sessions/verify` based on the arrival
of a request or an unauthenticated email. The public checkout endpoint must
remain strictly read-only and never mark an order paid.

**Do not mix Track A and B automatically.** Pick the designated authority for
each order at creation, persist it immutably, and refuse provider events for
manual-only orders. Do not turn on Slice email auto approval. Automatic delivery
must remain blocked pending independent provider status verification and all
fraud, tax, consumer and operator gates.

## 2. Provider selection and required contract evidence

A provider/bank must be chosen and its merchant onboarding/legal scope
validated by the owner before implementation. Record, in a restricted
document, the official versioned integration and operations contracts for:

1. Authenticated webhook algorithms and signed bytes (HMAC, asymmetric,
   or provider SDK as specified); any key IDs, header names, key rotation and
   replay/timestamp semantics; all **provider-specific**, never guessed.
2. Hosted checkout/session creation, unique payment/order/merchant account
   references, collection vs authorization vs capture vs settlement state, and
   whether payment status requires a second authenticated server API lookup.
3. Webhook retries and reordering, stale events, duplicate events, partial
   captures, reversals, refunds, disputes and payout reconciliation.
4. INR/paise precision, currency, buyer/order identity, merchant account
   matching and cutoffs; settlement account and legal merchant name.
5. Supported sandbox environment, distinct credentials, provider test events,
   operation limits, evidence/retention rights, data residency and reconciliation
   export, support SLA and escalation path.
6. Any applicable RBI/payment intermediary terms, PCI or data-processing
   restrictions and finance/GST consequences, as reviewed by qualified owners.

**Do not assume** provider calls, signatures or success event types before
collecting the authenticated provider documentation.

## 3. Ingress protocol — reject before parsing or financial action

The new webhook path (not created in this PR) would be server-only, HTTPS,
size-limited, rate-limited, and isolated from browser and bot cookies. Only
the verified provider endpoint may call it; do not expose a shared
`PAYMENT_API_SECRET` or checkout bearer capability to the provider.

For every request, in this order:

1. Obtain original **raw request bytes** with a strict body-size cap. Never
   reserialize parsed JSON and then compute its signature.
2. Resolve the exact configured provider integration and permitted key
   version from protected environment configuration; unknown provider/key
   fails closed. No account-ID, origin or secret is chosen by client-supplied
   JSON alone.
3. Verify the provider's **actual documented signature scheme over the exact
   documented bytes/metadata** with an approved library or reviewed code.
   Use constant-time comparison when relevant. Verify any documented
   timestamp, key version and nonce policy, with tolerated skew measured,
   while remembering legitimate delayed retries may be older than the
   signature's freshness window (reconcile these independently).
4. Reject bad/missing signature, wrong key, malformed content type, unsupported
   version or oversized payload with a generic response. Never emit raw
   webhook body, signature, bank receipt or secret in logs/errors.
5. Parse and schema-validate *only after* signature verification; require
   named event type, provider event ID and provider transaction ID. Use
   provider-documented IDs; don't invent one from a customer-supplied UTR.
6. Atomically persist a minimal verified event receipt under
   `UNIQUE(provider_id, event_id)`. Replays with identical immutable digest
   are acknowledged idempotently; same ID with different digest enters
   security review. The event receipt is not the same as a paid order.
7. Acknowledge only after durable storage. An asynchronous, bounded worker
   handles processing. Avoid unbounded retries, transient 5xx retry storms
   or permanent-data-loss acknowledgements.

If the provider sends no independently verifiable signed events, Track B
cannot be authorized by simply accepting IP allowlists, a "secret" in a URL,
static account names, an email sender or any caller-controlled proof.

## 4. Normalized, *untrusted-until-matched* event envelope

The verified adapter may emit an internal object **only after signature
checks**. Before any payment status transition it must match an immutable,
server-created order payment snapshot:

| Persisted field | Required check |
| --- | --- |
| `authority=provider_verified` | Customer order was explicitly created for this provider; never upgrade a manual-only order |
| `order_id`, `buyer_id`, `product/variant` | Provider's merchant order reference maps to exactly one existing persisted order and customer, not browser input |
| `merchant_account_id`, `recipient` | Configured actual Aventas merchant account/beneficiary matches the event/API record |
| `payable_amount_paise`, `currency` | Exact safe integer paise and `INR` match the immutable post-wallet amount; no float conversions or partial payment accepted as full |
| `provider_payment_id`, `provider_event_id` | Stable provider-issued identifiers; never reused to verify a second order |
| `provider_status`, `settlement_state` | Provider-specific status is on the **approved** fulfillment-authority allowlist and independently reconciled if required |
| `tax_quote_hash` / invoice link (where relevant) | A signed persisted GST quote matches the payment and eventual invoice; no invoice-time rerating |
| `key_version`, `timestamp` | Signed event verification, provider clock/retry policy and rotation scope established |

A matching payment amount and a verified signature are **both necessary but
not automatically sufficient**; provider account, customer/order, capture vs
settlement semantics, and duplicate/refund status must also match.

## 5. Durable idempotency, ordering and reconciliation

Design migrations **only after** provider selection and schema review.
Proposed minimal relational boundaries (names illustrative, not deployed):

- `provider_events`: `provider_id`, `event_id` unique; canonical event
  type; verified key version; raw-body digest (not full raw body); first
  receipt time; processing state; retry/age/error **category**; next attempt.
- `provider_payments`: `provider_id`, `provider_payment_id` unique;
  merchant account; immutable order ID; amount/currency; provider status;
  capture/settlement reference; first/last seen; stable receipt proof.
- `payment_ledger`: append-only transitions and separate adjustment entries;
  actor/source, time, version, immutable amount and linked refund/reversal ID.
- `provider_dead_letters`: bounded retries or contradictory/missing states
  go to restricted `NEEDS_REVIEW`, not silent deletion or success.

Enforce transaction/compare-and-swap uniqueness for both
`(provider_id, event_id)` and `(provider_id, payment_id)`; a settlement
reference must never authorize two orders. Update bot order truth, provider
payment state and durable delivery notification in a coherent transactional
plan, or explicitly reconcile database boundaries through the existing
idempotent outbox. Website PENDING/EXPIRED or notification failure must never
be used to infer that bank funds did not move.

Out-of-order webhook handling: a reversal/refund/dispute can arrive before
a capture event. Store and reconcile the chronology from provider-authenticated
information without moving the customer to an incorrect paid state. Duplicates,
later failed events and repeated signed captures cannot grant duplicate goods.

Do not destroy a PAID historical audit record on refund or chargeback.
Represent refunds, reversals, chargebacks, chargeback wins/losses and credit
notes as **separate linked ledger events** with their own authority checks,
staff escalation, entitlement/revocation and tax-document review.

## 6. Runtime isolation and failure policy

- Separate sandbox and production credentials, accounts, key IDs, webhook
  routes, order prefixes, DB bindings, audit destinations and queues.
- Feature flag must remain absent/off until a separately approved production
  canary. A hypothetical `AVENTAS_PSP_SETTLEMENT_ENABLED` is a **design
  placeholder, not an implemented toggle**.
- Rotate provider keys only with an approved overlap/window and old-event
  reconciliation policy. Do not disable the existing checkout token secret or
  expose raw keys in logs.
- No SSRF: callbacks never fetch a URL supplied in an event. Any follow-up
  verification call uses a fixed allowlisted provider HTTPS origin and the
  provider's own auth, without redirects to unknown origins.
- Timeouts, bounded backoff, circuit breakers, queue age/dead-letter alerts,
  refund/dispute escalation, per-provider reconciliation reports and on-call
  ownership must be measured in isolated staging.
- Limit retention of provider PII/bank details to an approved schedule.
  Operator logs include only event category, typed error, state, duration,
  hashed opaque reference and sanitized correlation ID. No full customer
  UTR, checkout bearer, secret, signature, bank payload or screenshots.

## 7. Synthetic acceptance matrix — must pass before Track B launch

| Test ID | Controlled test | Required result |
| --- | --- | --- |
| PSP-01 | Missing, wrong, malformed signature | No event processing or paid transition |
| PSP-02 | Valid signature with wrong key ID or merchant tenant | Reject/hold, no cross-merchant access |
| PSP-03 | Raw-byte mutation or body reordering under signed payload | Signature fails using original bytes |
| PSP-04 | Timestamp/nonce replay outside provider policy | Reject or reconcile explicitly; no duplicate transition |
| PSP-05 | Duplicate identical signed event ID | One durable event, idempotent acknowledgement |
| PSP-06 | Same event ID with different body digest | Security review, no duplicate delivery |
| PSP-07 | Same provider payment ID across two orders | Uniqueness conflict and operator review |
| PSP-08 | Wrong INR amount, currency, wallet deduction, merchant or payee | Never mark paid |
| PSP-09 | Wrong order, customer or manual-only authority | Never mark paid |
| PSP-10 | Signed `created`/`authorized` event without approved successful settlement state | No fulfillment |
| PSP-11 | Partial, split or late funds | Record discrepancy, no false full payment |
| PSP-12 | Valid confirmed provider payment and exact immutable order | One authorized payment transition and one delivery |
| PSP-13 | Concurrent signed duplicate confirms | One ledger record and one entitlement |
| PSP-14 | Refund before capture, reversal after capture, out-of-order webhook | No replayed fulfillment, separate adjustment ledger |
| PSP-15 | Partial/full refund, dispute and chargeback | Restricted review; no forged refund or unapproved credit note |
| PSP-16 | Server timeout between event persistence and delivery | Durable recoverable retry; no lost or double send |
| PSP-17 | Provider API timeout/5xx/429, retry cap, 401/403 and dead letters | Bounded attempts, alert, manual review |
| PSP-18 | Disabled toggle, wrong origin, bad schema or unverified sandbox | Zero paid transitions and no production data access |
| PSP-19 | Secret rotation across in-flight signed events | Old-key policy reviewed, no impersonation or silent drop |
| PSP-20 | Provider reconciliation vs bot + Worker + bank payout report | All discrepancies tracked and closed by authorized staff |
| PSP-21 | Customer redirect to `success` or client-side mutation | Cannot set PAID or issue a credit |
| PSP-22 | GST quote expiry/rate-change between order and capture | No invoice without saved signed quote and tax review |
| PSP-23 | Logs, 404/409 errors, vendor-provided PII | No secrets, payment bearer, raw evidence or customer identity leak |
| PSP-24 | Disaster restore, stale retry queue and manual fallback | No duplicate settlement/fulfillment, rollback evidence |

Run this matrix in a provider sandbox with an isolated bot, Worker/D1, database,
Discord test guild and test accounts. Use fake/test provider funds only.
Record exact revisions, test IDs, verification artifacts, redacted identifiers,
negative-case results, operator roles, rollback/recovery timing and provider
reconciliation output. Never mark this matrix completed by unit tests or
a generic signing stub alone.

## 8. Release decisions and ownership (still open)

- **Security/engineering:** choose and verify a real provider specification,
  review signing/normalization, enforce atomic DB behavior, SAST/advisory CI
  and complete sandbox failures.
- **Payments/merchant:** independently verify merchant legal account,
  provider capture/settlement authority, payouts, returns/refunds and
  financial reconciliation.
- **Privacy/compliance/GST:** approve notices, retention, refund/credit-note
  behavior, invoice facts and applicable provider/regulatory obligations.
- **Operations:** approve alerts, dead-letter ownership, staff support,
  incident rollback and monitored canary.
- **Release owner:** sign a separate Track B launch approval only after all
  required evidence and legal/merchant dependencies exist.

Until then, keep [Pay #18](https://github.com/Aventas-Org/Aventas-Pay/issues/18)
open; leave all automated bank/PSP settlement paths **UNIMPLEMENTED/OFF**.

## Incremental verification code (unconnected)

`website/src/services/payment/providerSettlementScreen.ts` adds a pure
pre-screen for *untrusted candidate* provider records: exact merchant,
provider, order, buyer, INR paise, optional tax-quote hash, status policy,
refunded/disputed state and previous payment assignment. **Every result is
`NEEDS_REVIEW`, `paymentVerified=false` and `canFulfill=false`.** The
successful candidate outcome is not a payment authorization. No provider
API call, webhook, signature verifier, credential, database, bot fulfillment
or production switch was added. The real provider-specific adapter and
signed settlement integration are still unimplemented and required by #18.

Read [2026-11-06 infrastructure snapshot](STAGING_READONLY_INVENTORY_2026_11_06.md)
for fresh *read-only* worker/bot isolation evidence and remaining gates.
