# Aventas-Pay

Stage 1 foundation for the Aventas Discord-to-website checkout integration.

This repository holds the **transplantable, tested core** of Stage 1, built
against the Stage 1 brief while the `Aventas-Org/Aventas-bot` and
`Aventas-Org/Aventas-website` repositories were unreachable. It is not yet
wired into production systems; see `docs/WORK_REMAINING_BLOCKED.md` for what
remains and how to resume.

## What Stage 1 is (and is not)

Stage 1 establishes: checkout-session creation over an authenticated
server-to-server contract, a website checkout page that renders the stored UPI
recipient + QR and polls a safe status endpoint, and bot-side integration
behind a feature flag. It does **not** implement automatic payment verification
— no customer-reachable path can mark a session `PAID` — and it does not replace
the existing manual UPI/screenshot workflow, which stays the fallback.

## Layout

| Path | Contents |
|---|---|
| `docs/CHECKOUT_API_CONTRACT.md` | Endpoint contracts, validation rules, state machine, example responses |
| `docs/TRUST_BOUNDARY_UPI_ROUTING.md` | Trust model; how existing primary/backup UPI selection is preserved |
| `docs/DEPLOYMENT_CHECKLIST.md` | Ordered transplant + migration + secret setup + smoke test |
| `docs/WORK_REMAINING_BLOCKED.md` | What still requires repository access |
| `docs/SECURITY_AUDIT_STAGE2.md` | Stage 2 audit: findings, fixes, residual risks |
| `docs/INTEGRATION_MAP_AND_SOURCE_OF_TRUTH.md` | Integrated architecture, DB ownership, verification reality |
| `website/` | Checkout-session domain core + handlers + D1 adapters (SQL store, SQL rate limiter) + tested migrations |
| `bot/avantas_checkout/` | Async aiohttp client: timeouts, bounded retries, deterministic idempotency, redacted logging |
| `frontend/` | Checkout page (Vite + React) + transplantable poller/QR-verification libs |

## Tests (all executed at Stage 2 handoff)

```
cd website  && bun test        # 114 pass (unit + migration-on-SQLite + hardening + rate limiter)
cd website  && bunx tsc --noEmit
cd bot      && python3 -m pytest tests/test_client.py tests/test_config.py -q   # 32 pass
cd bot      && python3 -m pytest tests/test_e2e.py -q                            # 7 pass (cross-system: real client -> real handlers -> real SQLite)
cd frontend && bun test        # 38 pass (lib + component tests, all five states)
cd frontend && bunx tsc --noEmit
```

The frontend also runs under the preview; every checkout state (loading,
awaiting payment, confirmed, expired, unavailable) can be exercised with
`/checkout/<any-token>?mock=pending|paid|expired|error`.

## Configuration

Bot side: see `bot/checkout.env.example`. Website side: two Worker secrets
(`AVENTAS_PAYMENT_API_SECRET` shared with the bot, `AVENTAS_PAYMENT_TOKEN_SECRET`
website-only) — setup commands in `docs/DEPLOYMENT_CHECKLIST.md`. No real
secrets are committed anywhere in this repository.
