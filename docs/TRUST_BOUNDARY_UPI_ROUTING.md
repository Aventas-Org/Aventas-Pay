# Trust Boundary & UPI Routing (Stage 1)

## Where the trust boundary sits

```
┌─────────────┐  Discord interaction   ┌──────────────────────┐
│  Customer   │ ─────────────────────▶ │   Aventas bot        │
└─────────────┘                        │  (trusted integration│
                                       │   owns order facts,  │
                                       │   UPI route choice)  │
                                       └──────────┬───────────┘
                                                  │ HTTPS + Bearer
                                                  │ AVENTAS_PAYMENT_API_SECRET
                                                  ▼
                                       ┌──────────────────────┐
                                       │  Aventas website     │
                                       │  (D1: checkout       │
                                       │   sessions + audit)  │
                                       └──────────┬───────────┘
                                                  │ bearer checkout token
                                                  ▼
┌─────────────┐   GET status (rate-limited,      │
│  Customer   │◀── minimal projection) ──────────┘
│  browser    │   renders stored QR payload
└─────────────┘
```

**Trusted side:** the bot. It selects the primary/backup UPI profile using the
existing `get_payment_profile()` presence logic (unchanged), reads the order and
its persisted amount from the bot database, and sends both over the
authenticated server-to-server channel.

**Untrusted side:** the customer browser. It can *read* a session by presenting
the bearer token and can *poll status*. It cannot supply an amount, a recipient,
a product, or a TTL, and it cannot cause any transition — including `PAID`.

## Why the recipient is fixed per session

The UPI recipient (`upi.vpa`, `upi.display_name`) and `payment_profile_id` are
**snapshotted into the session row at creation**. The public status endpoint
serves the snapshot; it never re-consults settings, presence or environment.
Consequences:

* Reloading the page, polling, or a later presence flip cannot change where the
  customer is told to pay within a session's lifetime.
* If the operator's presence changes so that a *different* profile would now be
  selected, existing sessions keep their original recipient; only new sessions
  (new attempts after expiry) pick up the new route.
* The customer can never inject a VPA: the only input the browser controls is
  the token, which maps to exactly one stored snapshot.

## Preserving existing primary/backup UPI selection

Stage 1 does **not** reimplement presence-based selection on the website. The
selection policy stays exactly where it works today — in the bot, driven by the
configured Discord operator's presence with the existing primary fallback — and
the chosen profile travels with the create-session request
(`payment_profile_id` + `upi` snapshot). This means:

* No duplicated or drifting presence logic across services.
* The manual UPI/screenshot workflow keeps working unchanged: the same
  `get_payment_profile()` output that feeds the Discord message also feeds the
  checkout session, so both channels always agree for a given order.
* When the website later gains its own authoritative order ledger, the selection
  can move server-side by swapping the source of the snapshot; the session
  schema and public contract do not change.

**Repository access required at transplant time:** trace the actual
`get_payment_profile()` implementation and the operator-presence settings, then
pass its result into `CheckoutClient.create_checkout_session(order, profile, ...)`
in the payment button callback. No new UPI IDs are invented anywhere in this
work; `upi.vpa` values in tests/fixtures are placeholders.

## Secrets

| Secret | Where it lives | Never |
|---|---|---|
| `AVENTAS_PAYMENT_API_SECRET` | Bot env + website Worker secret | In frontend code, logs, docs, git |
| `AVENTAS_PAYMENT_TOKEN_SECRET` | Website Worker secret only | Anywhere client-side; rotating it invalidates outstanding checkout tokens (coordinated rotation only) |
| Checkout token | Returned once to the bot over TLS; page URL | Logs, analytics, referrers, query strings |

## What Stage 1 explicitly does NOT do

* No automatic `PAID` from customer actions (button click, returning from a UPI
  app, page reload, screenshot upload).
* No payment-provider callbacks, webhooks or mock success endpoints.
* No migration of Discord order storage to D1; `checkout_sessions` is a
  parallel, additive record keyed by the existing order ID.
* No removal of the manual verification/delivery workflow — it remains the
  fallback whenever checkout is disabled or unavailable.
