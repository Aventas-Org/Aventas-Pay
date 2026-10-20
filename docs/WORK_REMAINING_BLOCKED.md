# Blocked Work — Requires Aventas-bot / Aventas-website Access

**Ground truth incorporated (from the maintainer-provided bot README):** the
real bot already has trusted automatic payment verification — Slice
payment-received emails matched over IMAP, deduped by Message-ID — plus
staff-role review; DATABASE_URL supports SQLite (`data/legion.db`) or Postgres
via asyncpg; order IDs are `AVT-xxxxxxxxxx` with legacy `LGN-` still valid
(both pinned by tests in `website/test/verifySession.test.ts`); CI runs
`python -m unittest discover` (note: our checkout tests use pytest and would
need pytest added to that workflow, or conversion, at transplant time); the
bot's .env convention is unprefixed, now accepted as a fallback by the config
loader (AVENTAS_-prefixed names still win). The server-to-server verify
endpoint added in Stage 2 is the landing point for the bot's existing
post-verification hook.

**Stage 2 status:** re-verified at Stage 2 start (branch `stage-2-integration`):
`git ls-remote` against both repositories still returns `remote: Repository
not found.` with the configured GitHub credentials; `gh repo list Aventas-Org`
still shows only `Aventas-Pay` and `Aventas-Companion`. Everything in this file
depends on reading the real source and therefore could NOT be completed.
Nothing here has been fabricated or approximated against guessed APIs.

**Stage 2 did complete (in this workspace):** the D1-store adapter, both
migrations tested against real SQLite, request-size limits, redacted structured
logging, a cross-isolate SQL rate limiter, frontend accessibility + page-leave
cancellation, a real component-test suite (which found and fixed a
page-crashing Stage 1 bug), a security audit with fixes
(`SECURITY_AUDIT_STAGE2.md`), the integration map / source-of-truth doc, and a
cross-system end-to-end suite driving the real Python client against the real
handlers over HTTP with the real SQL store.

## Blocked items

1. **Runtime patch trace.** The exact patch application order in `bot.py`
   (`payment_precision_patch`, `payment_screen_reliability_patch`,
   `checkout_reliability_patch`) and the real payment-button callback chain were
   never read. The bot integration here is a standalone service; the call-site
   edit (defer interaction -> build OrderFacts from the DB -> create session ->
   present link, with manual fallback) is specified in
   `docs/DEPLOYMENT_CHECKLIST.md` step 4 but not applied to their code.

2. **Schema reconciliation.** `0001_checkout_sessions.sql` is additive and
   convention-agnostic on purpose, but it must be aligned with the real
   `api/schema.sql` (id format, timestamp type, migration ordering) before
   applying. It must also be confirmed that no existing table already covers
   payment sessions under a different name.

3. **Router wiring.** Mounting the handlers inside `functions/api/[[route]].ts`
   (or the actual router) and writing the D1 `SessionStore` adapter against the
   real D1 binding/wrangler configuration.

4. **Design-system integration.** The checkout page
   (`frontend/src/CheckoutPage.tsx`) is a self-contained, verified implementation
   (all five states render; preview confirmed) but uses its own visual theme. It
   must be re-skinned into the Aventas website's existing routing, typography,
   components and API client utilities, replacing the demo fetch with their
   client.

5. **get_payment_profile() integration.** Passing the existing presence-based
   selection result into `CheckoutClient.create_checkout_session(..., profile=)`
   at the call site. The trust-boundary rationale is documented in
   `docs/TRUST_BOUNDARY_UPI_ROUTING.md`; the actual selection code was not read.

6. **Regression suite against the real bot.** Existing shop navigation, VP/Steam
   catalogue, loyalty wallet, order IDs (incl. legacy), Cloudflare order sync
   outbox, staff verification, roles, sales records, fulfillment and delivery DMs
   must be regression-tested in their repositories. None of that code was
   readable here, so those suites were not run.

7. **Ownership-check wiring.** The client enforces
   `order.owner_discord_id == actor_discord_id` before any HTTP call (tested),
   but binding it to the real cog's interaction author requires their code.

## How to resume

1. Grant the git credentials access to both repos (GitHub org -> Settings
   -> Deploy keys / OAuth app; Contents read/write + Metadata, + Pull
   requests for PR delivery). If the repos were renamed, provide the correct
   `owner/name`.
2. Say "continue" — the first action will be `git ls-remote` against both repos,
   then the workflow in `docs/DEPLOYMENT_CHECKLIST.md` from step 1, starting
   with the patch-order trace and schema reconciliation before any call-site
   edits. The transplant payload is ready: `website/src` (handlers + SQL
   adapters), `bot/avantas_checkout`, `frontend/src`, with all tests.
3. Nothing in this workspace needs to be thrown away: it is the transplant
   payload; its tests travel with it.
