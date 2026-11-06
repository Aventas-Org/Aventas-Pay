# Aventas Pay infrastructure — read-only snapshot (2026-11-06)

**Purpose:** update historic BLOCKED inventory with fresh connected account reads.
**Status:** NOT a staging acceptance signoff, real-money test or launch approval.
No account, Worker, D1, route, secret, bot variable or deployment was changed
while producing this snapshot. Do not reproduce private values in logs.

## Cloudflare (authenticated read-only)

- Account contains the pre-existing `aventas-staging` Worker, last deployed
  2026-11-06 13:59 UTC. Its `DB` binding points to pre-existing
  `aventas-staging-db` D1 `9e298657-2d0f-4dcc-818d-9435386c3050`.
- The staging Worker has `PAYMENT_API_SECRET` and
  `PAYMENT_TOKEN_SECRET` secret-text bindings and a
  `PAYMENT_WEBSITE_BASE_URL` plain-text binding. **Presence does not
  attest secret entropy, correct origin value or bank proof.**
- Staging D1 schema lists `checkout_sessions`,
  `checkout_session_events`, `checkout_rate_limits` among its tables;
  no live accepted transactions or staging acceptance execution was inspected.
- The production `aventas` Worker uses a different D1,
  `170a4050-49c3-49ad-a08d-7c07cc0e38d9`. In the read-only
  table-name inventory, production did **not** contain checkout tables.
- The staging Worker's `workers.dev` subdomain is disabled. The connected
  zone `aventasgaming.com` has only its apex Worker route pointing to
  production `aventas` at the time inspected. **No independently verified
  public HTTPS staging hostname/route; do not assume the runtime acceptance
  runner is reachable.**

## Railway (authenticated read-only)

- Separate existing project `Aventas Pay Staging` with environment `staging`.
- `aventas-pay-test-bot` deploy SUCCESS at 2026-11-06 13:59 UTC,
  from `Aventas-Org/Aventas-bot` main commit
  `f045d591cd9782413ff9d200d461e967f1835476`.
- Independent 1 GB `/data` volume attached to test service.
- Configuration **names** include checkout, reconciliation, Slice
  auto-approval flags and payment API origins/secrets. Railway returned only
  **variable names**; actual flag values, credentials, guild/account isolation,
  UPI recipient and finance acceptability **remain unverified**.

## Remaining P0 steps (owner-led)

1. Designate the legally approved business receiving/merchant account and
   supported sale-of-gaming-digital-goods category. Current personal Slice
   savings account cannot be assumed eligible for business collections.
2. Confirm the staging bot points only to an authorized isolated test guild,
   dedicated test database and no payable personal/business UPI target;
   inspect values in owner-controlled secure consoles (never share secrets
   in issues, logs or chat). Read-only variable names are not enough.
3. Approve an isolated HTTPS staging route and appropriately fake non-payable
   UPI instructions **before** exposing a public staging checkout.
4. Execute the already-merged staging acceptance runner, bot restart/receipt
   notification/outbox tests and rollback drill, with recorded evidence.
5. Record staff authority, finance/GST quote and invoice binding, privacy,
   refund/dispute/support signoffs, and canary/rollback approval.
6. For automated settlement only: select and get merchant approval from a
   bank/PSP, implement provider-specific documented raw webhook signature,
   status lookup, durable event/payment deduplication and reconciliation.
   Neither a mailbox credential nor fractional amount is settlement proof.

**Decision:** NO-GO for live hosted checkout or automatic fulfillment. The
currently connected evidence proves some isolated infrastructure exists,
not that commercial payment acceptance is safe.
