# Aventas Stage 1 — Checkout Session API Contract

Status: **implemented as tested, transplantable modules** in this repository
(`website/src/`, `bot/avantas_checkout/`, `frontend/src/`). Endpoint paths,
payloads and status codes below are what the handlers in `website/src/handlers/`
produce today; wiring them into the Aventas-website Worker router
(`functions/api/[[route]].ts`) and the Aventas-bot cogs is the transplant step
that requires repository access.

## Trust model (Stage 1)

The Aventas-website ledger cannot yet authoritatively validate a bot order, so
Stage 1 uses a clearly authenticated integration contract:

* The **Discord bot is the trusted source** of order facts. It reads the order
  from its own database and sends the *persisted* amount over a server-to-server
  channel authenticated with a dedicated secret
  (`AVENTAS_PAYMENT_API_SECRET`).
* The **server never trusts public input**: no public endpoint accepts an
  amount, a recipient, a product or a price. The public status endpoint accepts
  only a bearer checkout token and returns a fixed, minimal projection.
* Every session records `source = discord_bot` so that when the website ledger
  becomes authoritative (later stage), provenance is already auditable.
* `PAID` is unreachable from any customer-reachable path. See
  `TRUST_BOUNDARY_UPI_ROUTING.md` for how this interacts with UPI routing and
  the future verification integration.

## Authentication

| Channel | Credential | Comparison |
|---|---|---|
| Bot -> website (create, cancel) | `Authorization: Bearer $AVENTAS_PAYMENT_API_SECRET` | SHA-256 digests compared in constant time (`constantTimeEqual`) |
| Customer -> website (status) | Bearer checkout token in the URL path | Token shape validated, then looked up by SHA-256 hash |

* Secrets are never logged; the bot client masks token-like strings and
  secret-named keys before any log line is emitted.
* Tokens are never placed in query strings (they would leak via referrers);
  the path form is paired with `Referrer-Policy: no-referrer` and
  `<meta name="referrer" content="no-referrer">` on the page.

## Endpoints

### 1. Create checkout session (server-to-server)

```
POST /api/payments/checkout-sessions
Authorization: Bearer <AVENTAS_PAYMENT_API_SECRET>
Content-Type: application/json
```

Request:

```json
{
  "order_id": "AVT-2026-000123",
  "discord_user_id": "123456789012345678",
  "product_id": "vp-1000",
  "product_name": "1000 Valorant Points",
  "amount_paise": 99900,
  "currency": "INR",
  "payment_profile_id": "primary",
  "upi": { "vpa": "merchant@upi", "display_name": "Aventas Store" },
  "idempotency_key": "AVT-2026-000123:checkout-session",
  "ttl_seconds": 1800
}
```

Validation (all server-side; every failure returns 400 with only field NAMES):

* `order_id`, `product_id`: `[A-Za-z0-9._-]{1,64}`
* `discord_user_id`: 15–20 digit snowflake
* `amount_paise`: safe integer, 100 (₹1) … 1_000_000_000 (₹1 crore)
* `currency`: must be exactly `INR`
* `payment_profile_id`: `[a-z0-9_-]{1,32}`
* `upi.vpa`: standard VPA charset; `upi.display_name`: 1–64 printable chars
* `ttl_seconds`: 300 … 7200, default 1800
* `idempotency_key`: optional; defaults to `{order_id}:checkout-session`

Response `201` (created) or `200` (reused existing active session):

```json
{
  "order_ref": "AVT-2026-000123",
  "product": { "name": "1000 Valorant Points" },
  "amount_paise": 99900,
  "amount_display": "999.00",
  "currency": "INR",
  "upi": { "vpa": "merchant@upi", "display_name": "Aventas Store" },
  "qr_payload": "upi://pay?pa=merchant%40upi&pn=Aventas%20Store&am=999.00&cu=INR&tn=Aventas%20order%20AVT-2026-000123",
  "expires_at": "2026-10-20T10:30:00.000Z",
  "session_status": "PENDING",
  "checkout_token": "<43-char base64url>",
  "checkout_url": "https://avantas.example/checkout/<checkout_token>",
  "reused": false
}
```

Idempotency semantics:

* An **active** (PENDING & unexpired) session for the same order is returned as
 -is (`reused: true`, HTTP 200); the checkout token is re-derived
  deterministically (`HMAC-SHA256(secret, "avantas-checkout:v1:" + session_id)`),
  so retried requests always produce the identical checkout URL.
* After expiry/terminal state, the next request opens attempt N+1 with a fresh
  token. `UNIQUE(idempotency_key, attempt)` rejects concurrent duplicates; the
  loser resolves by returning the winner's session.

Errors: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `429 RATE_LIMITED`
(+ `retryAfterSeconds`), `500 INTERNAL_ERROR` — all with generic messages.

Rate limit: 120 requests/minute per client IP (abuse containment).

### 2. Public session status (customer browser)

```
GET /api/payments/checkout-sessions/{checkout_token}
```

Response `200`:

```json
{
  "order_ref": "AVT-2026-000123",
  "product": { "name": "1000 Valorant Points" },
  "amount_paise": 99900,
  "amount_display": "999.00",
  "currency": "INR",
  "upi": { "vpa": "merchant@upi", "display_name": "Aventas Store" },
  "qr_payload": "upi://pay?pa=merchant%40upi&pn=Aventas%20Store&am=999.00&cu=INR&tn=Aventas%20order%20AVT-2026-000123",
  "expires_at": "2026-10-20T10:30:00.000Z",
  "status": "PENDING"
}
```

Guarantees:

* The projection **structurally omits** `discord_user_id`, internal session id,
  `payment_profile_id`, `idempotency_key`, `attempt`, `token_hash`, `source`
  and `provider_transaction_ref` (verified by tests).
* `qr_payload` is rebuilt from the **stored session snapshot**, so the QR always
  matches the recipient and amount fixed at creation, across reloads.
* Unknown or malformed tokens: `404 NOT_FOUND` with the generic message
  "Checkout session not found."; malformed tokens never reach the database.
* A PENDING session at/after `expires_at` reports `EXPIRED`; the transition is
  persisted best-effort for the audit trail and can never be reversed.
* Headers on every response: `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
* Rate limit: 30 requests/minute per client IP.

### 3. Cancel session (server-to-server, optional in Stage 1)

```
POST /api/payments/checkout-sessions/cancel
Authorization: Bearer <AVENTAS_PAYMENT_API_SECRET>
Content-Type: application/json

{ "order_id": "AVT-2026-000123" }
```

* Same auth as creation. Idempotent: cancelling an already-terminal session
  returns `200` with the current state and performs no transition.
* Unknown order: generic `404`.

## Status state machine

```
PENDING ──▶ PAID        (trusted verifier ONLY; requires provider_transaction_ref)
PENDING ──▶ EXPIRED     (time-based; at/after expires_at)
PENDING ──▶ CANCELLED   (authorized bot operation)
PAID / EXPIRED / CANCELLED are terminal — no outgoing transitions.
```

* An expired session **cannot be revived**: `PENDING -> PAID` after expiry
  throws `IllegalTransition`. Late-arriving payments are reconciled out-of-band
  in a later stage via the audit trail + provider reference, never by flipping
  a dead session back to life.
* Concurrent transitions use optimistic concurrency (`updateStatus` matches on
  the expected current status); the losing writer surfaces the current state
  instead of overwriting.
* Stage 1 exposes **no HTTP route to PAID**. `recordTrustedPayment()` exists in
  the domain layer solely for the future verification integration.

## UPI deep link format

Standard `upi://pay` intent, no provider-specific payload:

```
upi://pay?pa={vpa}&pn={name}&am={rupees.2dp}&cu=INR&tn=Aventas%20order%20{order_id}
```

Spaces are encoded `%20` (not `+`) for UPI-app compatibility. The page renders
the server-stored `qr_payload` verbatim and independently re-derives it
(`frontend/src/lib/qr.ts::verifyQrMatchesSession`) before rendering, so a
mismatched payload falls back to showing the UPI ID only. A QR is payment
*instruction*, never evidence of payment.

## Statuses mapped to a hypothetical existing model

If the Aventas-website repository reveals a compatible existing state model,
map: `PENDING ~ awaiting_payment`, `PAID ~ paid/captured`, `EXPIRED ~ expired`,
`CANCELLED ~ cancelled`. The names above are the Stage 1 canonical ones.
