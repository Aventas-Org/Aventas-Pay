# Stage 2 Security Audit — Findings & Fixes

Audited the integrated implementation against the Stage 2 checklist. Each item
lists the verdict, where it is enforced, and the test that pins it.

## Findings

### S1 (fixed, Stage 1 bug) — Checkout page crashed on real payloads
`parseSnapshot()` returned only `{status, expires_at}`, discarding the rest of
the server payload, so `SessionCard` crashed on `session.product.name` the
moment a real (or mock) session rendered — a blank page for every customer.
Found by the new component tests, not by the unit tests (which only exercised
the poller's logic layer). **Fix:** pass the full validated payload through
(`checkoutPoller.ts`); component tests now render all five states.

### S2 (fixed) — No request-size limit on the create endpoint
An authenticated caller could post a multi-megabyte body that the isolate would
buffer and parse. **Fix:** `MAX_BODY_BYTES = 4096` enforced on raw UTF-8 byte
length before `JSON.parse` (`handlers/http.ts`), returning `413
PAYLOAD_TOO_LARGE`. Tests cover ASCII and multi-byte overflow.

### S3 (fixed) — In-memory rate limiter was the only abuse control
Per-isolate memory does not survive isolate recycling and is not shared across
the multi-isolate Worker deployment. **Fix:** `SqlRateLimiter`
(`adapters/sqlRateLimiter.ts`) + additive migration `0002_rate_limits.sql`,
atomic UPSERT..RETURNING, identical interface. Verified against real SQLite:
limits, windows, cross-instance sharing, durability across reopen, concurrent
atomicity (20 parallel consumes vs limit 10 → exactly 10 pass), pruning.
Production wiring guidance: prefer a Durable Object limiter at high traffic;
the SQL variant is the floor, not the ceiling.

### S4 (fixed) — Server had no structured logging
Failures were invisible to operators. **Fix:** `domain/log.ts` with
redaction-guarded JSON-line logging wired into create/status/cancel and the
500 path. Tests assert captured logs contain ops fields but never the token,
secret, Discord ID or VPA.

### S5 (verified, no fix needed) — Token handling
256-bit HMAC-derived bearer tokens; DB stores only SHA-256; shape-validated
before lookup (malformed tokens never touch the DB — call-count test); token
in URL path (not query) + `Referrer-Policy: no-referrer` + `Cache-Control:
no-store` + `noindex`; deterministic derivation is a documented tradeoff
(rotation invalidates outstanding tokens).

### S6 (verified) — Forged payment-state transitions
No public route performs transitions. E2E: POST/PUT/PATCH to the token URL and
forged `status: PAID` bodies are rejected; `?status=PAID` query smuggling is
ignored (stored state wins); session remains PENDING. Domain-level: `PAID`
requires `recordTrustedPayment()` + provider reference; expired sessions throw
`IllegalTransition` even on the trusted path.

### S7 (verified) — SQL injection
All statements are fixed strings with positional parameters through the
`SqlExecutor` port (structurally no interpolation). E2E store test inserts
`x'; DROP TABLE checkout_sessions; --` as a literal `order_id`; table intact.

### S8 (verified) — Ownership & auth
Bot-side ownership check raises before any HTTP call (zero-request test);
server auth is constant-time SHA-256 comparison; wrong/missing/malformed auth
→ generic 401 with no retry; empty server secret rejects everything.

### S9 (verified) — Race conditions
Optimistic guarded UPDATE (`WHERE status = from`) with rowsAffected semantics
tested against real SQLite; UNIQUE(idempotency_key, attempt) resolves
concurrent creates; the losing writer surfaces current state, never overwrites.

### S10 (verified) — Error paths
`dispatch()` converts every unexpected exception to a generic 500; DB-failure
test asserts no SQL/error text leaks; expiry audit-write failure degrades to a
correct read.

## Residual risks (accepted for Stage 2, documented)

* **Secret-bearing checkout URLs.** The token is a bearer capability in the
  URL path. Mitigations above; residual risk of OS-level history/shoulder
  surfing accepted (same class as password-reset links).
* **SQL rate limiter latency.** One D1 write per public request. Acceptable at
  Stage-2 volumes; DO limiter recommended before high-traffic launch.
* **Bot channel trust.** Amounts originate from the authenticated bot; a
  compromised bot secret can create sessions for arbitrary amounts. Mitigated
  by secret hygiene + audit `source` field; closed properly when the website
  ledger becomes authoritative (Stage 3+).
* **No CORS surface.** The checkout page is same-origin; no CORS headers are
  emitted. If the website later serves the page cross-origin, revisit.
