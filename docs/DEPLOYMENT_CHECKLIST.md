# Deployment Checklist — Aventas Stage 1 Checkout

> Run these steps in order when transplanting this work into the real
> Aventas-website and Aventas-bot repositories. **Do not run production
> deployment or set live secrets without explicit authorization.**

## 0. Preconditions

- [ ] `Aventas-Org/Aventas-bot` and `Aventas-Org/Aventas-website` are reachable
      (GitHub credentials configured with read/write access to both repos).
- [ ] Feature flag stays `AVENTAS_CHECKOUT_ENABLED=false` in production until
      step 6.
- [ ] No production secrets are pasted into docs, tests, fixtures or git history.

## 1. Website: database migration (additive only)

- [ ] Merge `website/migrations/0001_checkout_sessions.sql` into the website
      repo's own migration flow. **First** reconcile conventions with the real
      `api/schema.sql` (id format, timestamp type — INTEGER epoch vs ISO TEXT,
      migration file naming/ordering). The migration only CREATEs new objects;
      it never ALTERs or DROPs anything existing.
- [ ] Apply to a staging D1 database:
      `wrangler d1 migrations list <DB_NAME>` (confirm ordering), then
      `wrangler d1 migrations apply <DB_NAME> --env staging`
- [ ] Verify: `wrangler d1 execute <DB_NAME> --env staging --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'checkout%'"`
      shows `checkout_sessions` and `checkout_session_events`.

## 2. Website: Worker secrets

- [ ] Generate two independent 32+ byte secrets (e.g. `openssl rand -base64 48`):
      - `AVENTAS_PAYMENT_API_SECRET` — shared with the bot.
      - `AVENTAS_PAYMENT_TOKEN_SECRET` — website-only (checkout token derivation).
        Rotating this invalidates outstanding checkout tokens; coordinate it.
- [ ] `wrangler secret put AVENTAS_PAYMENT_API_SECRET --env staging`
- [ ] `wrangler secret put AVENTAS_PAYMENT_TOKEN_SECRET --env staging`
- [ ] Confirm neither secret appears in `wrangler.toml`, frontend bundles or git.

## 3. Website: wire the handlers into the router

- [ ] Mount the three handlers in `functions/api/[[route]].ts` (or the repo's
      actual router): create + cancel behind the bot bearer auth, status as the
      public token endpoint. Handlers already return full `Response`-shaped
      objects (`status`, `headers`, `body`) and catch their own errors.
- [ ] Implement the `SessionStore` port (`website/src/domain/types.ts`) as a D1
      adapter over the new tables; the in-memory test double
      (`website/test/helpers/memoryStore.ts`) documents the required semantics,
      including throwing `IdempotencyConflict` on `UNIQUE(idempotency_key,
      attempt)` violations.
- [ ] Swap the in-memory rate limiter for a Durable Object / D1-backed limiter
      if the site runs multiple isolates (interface stays identical).
- [ ] Add the checkout page route (`/checkout/:token`) using the frontend
      module; point it at the status endpoint; keep `<meta name="referrer"
      content="no-referrer">` and `Cache-Control: no-store`.

## 4. Bot: install the checkout service

- [ ] Copy `bot/avantas_checkout/` into the bot repo (e.g.
      `services/checkout_service.py` + package, matching repo conventions).
- [ ] Add the environment variables from `bot/.env.example.checkout` to the
      bot's `.env` (values via the secret manager, never committed).
- [ ] In the existing payment/Pay Now callback:
  - [ ] Verify `interaction.user.id == order.owner_discord_id` (the client also
        enforces this before any HTTP call).
  - [ ] Load the order from the bot database; build `OrderFacts` from the
        persisted amount (after existing rounding).
  - [ ] Resolve the profile via the existing `get_payment_profile()` and map it
        to `PaymentProfile`.
  - [ ] Defer the interaction response first (Discord 3s limit), then await
        `create_checkout_session(...)`; on `CheckoutError`, fall back to the
        existing manual UPI message. Never acknowledge twice.
  - [ ] Keep every existing payment/verification cog untouched.
- [ ] Run the bot test suite: `cd bot && python3 -m pytest tests/ -q`.

## 5. Verification before enabling

- [ ] Website tests: `cd website && bun test` (87 passing at handoff).
- [ ] Frontend tests: `cd frontend && bun test` (29 passing at handoff).
- [ ] Typecheck both TS packages: `bunx tsc --noEmit` in `website/` and
      `frontend/`.
- [ ] Stage smoke test on staging with `AVENTAS_CHECKOUT_ENABLED=true` in the
      bot's staging env only:
  - [ ] Create a session from a real (staging) order; confirm 201 + URL.
  - [ ] Open the URL in a browser: correct order ref, product, amount, UPI ID;
        QR scans to the exact stored VPA + amount in a UPI app.
  - [ ] Reload the page: recipient unchanged.
  - [ ] Repeat the Discord button click: `reused: true`, same URL, one session
        row in D1.
  - [ ] Wait for expiry: page shows EXPIRED; a status GET returns EXPIRED; a
        new click opens attempt 2 with a fresh token.
  - [ ] Stop the website (or point `AVENTAS_PAYMENT_API_URL` at a dead port):
        Discord flow shows the friendly error and the manual UPI fallback.
  - [ ] Confirm no `PAID` is reachable without a trusted verifier (there is no
        route to it in Stage 1).

## 5b. Rollback strategy

Both migrations are additive-only (they CREATE new objects and never ALTER or
DROP anything existing), so rollback never requires touching existing data:

* **Feature rollback (primary, no schema change):** set
  `AVENTAS_CHECKOUT_ENABLED=false` in the bot env. No new sessions are created;
  existing sessions simply expire; the manual UPI flow continues. No redeploy
  of unrelated components; no schema downgrade.
* **Route rollback:** remove/unmount the three checkout routes in the Worker
  router. The tables remain, inert. The checkout page route then 404s — pairs
  with disabling the flag so customers never see a link that dies.
* **Schema rollback (rarely needed):** because nothing else reads these tables,
  dropping them is safe once the flag is off and all sessions have expired
  (max TTL 2h). Optional explicit statements, run only after confirming no
  active sessions:
  ```sql
  DROP TABLE IF EXISTS checkout_session_events;
  DROP TABLE IF EXISTS checkout_sessions;
  DROP TABLE IF EXISTS checkout_rate_limits;
  ```
  `checkout_rate_limits` may be kept even with checkout disabled — it is inert
  and harmless.
* **Never** write a migration that modifies existing Aventas tables; that is
  the one rollback class that could damage live data.

## 6. Rollout

- [ ] Enable for one test account / private server first (flag on in bot env).
- [ ] Watch bot logs for `checkout session_ready` / `request_failed` events and
      website 4xx/5xx rates.
- [ ] Flip `AVENTAS_CHECKOUT_ENABLED=true` broadly. Rollback = flip back to
      `false`; no redeploy of unrelated components, no schema downgrade needed
      (tables are additive and inert when unused).

## 7. Explicitly out of scope for Stage 1 (do not enable)

- [ ] No automatic `PAID` transitions: there is no trusted verification source
      yet. Sessions stay PENDING until Stage 2 wires `recordTrustedPayment()`
      to an approved provider/bank source.
- [ ] No durable automated Discord delivery-code DMs (later stage).
- [ ] Do not remove the manual screenshot-verification workflow.
