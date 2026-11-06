# Stage 2 Integration Map, Database Ownership & Source of Truth

## What was integrated (in this workspace)

```
website/
  src/adapters/sqlPort.ts           SqlExecutor port (D1 / bun:sqlite)
  src/adapters/sqlSessionStore.ts   production SessionStore over parameterized SQL
  src/adapters/sqlRateLimiter.ts    cross-isolate SQL rate limiter
  src/domain/log.ts                 redaction-guarded structured logging
  src/handlers/*.ts                 + size limits, logging, async limiter await
  migrations/0001_checkout_sessions.sql   (tested against real SQLite)
  migrations/0002_rate_limits.sql         (tested against real SQLite)
  test/e2e/server.ts                REAL handlers + REAL store over HTTP
  test/migration.test.ts            12 migration/constraint tests
  test/sqlRateLimiter.test.ts       7 durable-limiter tests
  test/hardening.test.ts            size-limit + redaction tests
bot/
  avantas_checkout/                 (unchanged from Stage 1)
  tests/test_e2e.py                 7 cross-system tests (client -> server)
frontend/
  src/CheckoutPage.tsx              + a11y, pagehide cancellation, S1 crash fix
  src/lib/checkoutPoller.ts         + full-payload pass-through (S1 fix)
  test/CheckoutPage.test.tsx        9 component tests (all 5 states, copy, leaks)
```

## Request path (as implemented)

```
Discord interaction
  └─ bot cog (NOT yet wired — blocked) 
       ├─ ownership check (actor == order.owner)
       ├─ OrderFacts from bot DB (persisted amount, post-rounding)
       ├─ PaymentProfile from existing get_payment_profile()
       └─ CheckoutClient.create_checkout_session()
            └─ POST {website}/api/payments/checkout-sessions  (Bearer secret)
                 ├─ constant-time auth            (handlers/createSession.ts)
                 ├─ rate limit  (SqlRateLimiter / D1, 120/min/IP)
                 ├─ size limit  (4 KB, before parse)
                 ├─ full field validation
                 ├─ dedupe: active session per order  -> 200 reused
                 ├─ INSERT  UNIQUE(key, attempt)      -> 201 created
                 └─ audit event SESSION_CREATED
  └─ bot presents checkout_url to the customer

Customer browser
  └─ GET {website}/checkout/{token}          (page; no-referrer meta)
       └─ GET /api/payments/checkout-sessions/{token}   (30/min/IP)
            ├─ token shape check -> hash -> SqlSessionStore lookup
            ├─ effectiveStatus() = EXPIRED when PENDING && now >= expires_at
            └─ minimal projection (no discord id / ids / keys / hashes)
       poller: 5s base, exp backoff to 60s, 8s request timeout,
               stops on PENDING->terminal or expiry or 8 consecutive failures,
               aborts on pagehide/unmount
```

## Database ownership

| Store | Owns | Never contains |
|---|---|---|
| Bot SQLAlchemy DB | Orders, amounts, customers, fulfillment, delivery codes, sales records, Cloudflare sync outbox | Checkout sessions |
| Website D1 `checkout_sessions` | Session lifecycle + UPI snapshot + audit events | Sales/completion state; fulfillment |
| Website D1 `checkout_rate_limits` | Abuse counters | Anything durable |

**Checkout session creation never writes a sale.** There is deliberately no
code path from session creation to any completed-sale record; sessions are
inert rows that expire. Verified: e2e asserts PENDING after creation and no
customer-reachable transition to PAID.

## Source of truth

| Fact | Source of truth | Consumers |
|---|---|---|
| Order existence, ownership, amount (incl. rounding) | Bot DB | Bot only; sent over authenticated channel |
| Checkout session status | Website D1 `checkout_sessions.status` (+ time-based effective EXPIRED) | Checkout page, bot (optional) |
| UPI recipient for a session | Snapshot in the session row (fixed at creation) | QR + displayed ID (asserted equal) |
| Payment actually received | Bot verification: staff verifier role OR Slice email IMAP matcher (see below) | Bot (records), website session via server-to-server verify |
| Fulfillment / delivery | Bot DB, via existing staff verification flow | Discord staff + customer |

Two databases are never assumed to share a transaction. The correlation key is
the existing order ID; partial-failure handling: a session whose create request
died mid-flight simply doesn't exist (bot falls back to manual UPI); a session
without a later fulfillment record is inert and expires — no reconciliation
cron is required at Stage 2 volumes because nothing depends on the session
existing.

## Payment verification: what exists today, what is missing

*Updated against the actual Aventas-bot README (provided by the maintainer).
Code-level confirmation still requires repository access.*

**Available today in the real bot (trusted):**
1. **Staff verification** — the configured verifier role approves a payment
   proof in Discord. Human-in-the-loop, authoritative by policy.
2. **Automatic Slice email matching** — when `PAYMENT_EMAIL_USER` /
   `PAYMENT_EMAIL_PASSWORD` are set, the bot verifies customer payment proofs
   against **Slice payment-received emails over IMAP** in the merchant's own
   mailbox. Auto-verification requires the exact order amount plus either a
   screenshot time/date inside `PAYMENT_MATCH_TIME_WINDOW_MINUTES` of the email
   time or a matching transaction ID, within a bounded retry budget. Each
   receipt is keyed by the Slice email's **Message-ID**, so one receipt can
   never verify two orders.

**What that means for checkout sessions:**
A trustworthy PAID source **already exists inside the bot** — no new PSP
contract is required for Stage 3. The integration point is the new
server-to-server verify endpoint:

```
POST /api/payments/checkout-sessions/verify   (Bearer bot secret)
{ "order_id": "AVT-...", "provider_transaction_ref": "<Slice Message-ID or staff ref>" }
```

The bot calls it from its existing post-verification hook — after staff
approval OR after the Slice mailbox matcher auto-verifies — with the Slice
Message-ID (or staff reference) as `provider_transaction_ref`. The website
records the assertion; it does not re-verify money. A partial unique index
(migration 0003) makes one reference unusable for a second order, mirroring
the bot's Message-ID dedup rule as database-level defense in depth. Expired or
cancelled sessions cannot be verified late (409), so a dead session is never
revived; late payments reconcile out-of-band via the audit trail.

**Explicitly NOT available and NOT implemented:**
* No PSP webhook (Cashfree/PhonePe/Razorpay) — an optional future upgrade,
  not a blocker, since Slice email matching already provides a trusted signal.
* No NPCI push-verification API (none exists for this use case).
* No webhook endpoint reachable by customers that could be forged into PAID.

**The verify endpoint must remain server-to-server only** and must never be
called on a customer action, redirect, polling response or unreviewed
screenshot. Fulfillment/delivery stays in the bot's existing verified flow;
recording PAID on a session does not, by itself, deliver anything.
