# Aventas-Pay

Canonical checkout-session core for the Aventas Discord bot and website. The website vendors `website/src/{adapters,domain,handlers}` under `functions/api/pay/` and the three SQL migrations under `migrations/`. The website Worker mounts create, status, cancel, and trusted verify routes; its `/checkout/:token` page renders the stored UPI recipient and QR. The bot keeps its manual UPI, QR, and screenshot workflow and adds a hosted link only when checkout is enabled and reachable.

A checkout visit, QR scan, screenshot, or public poll never marks an order paid. Only the bot's trusted staff approval or verified Slice-email path may call the server-to-server verify endpoint. Checkout is disabled by default. Passing tests does not imply staging or production activation.

## Source and verification

- `website/`: checkout handlers, SQL store, durable rate limiter, additive migrations, and isolated handler/security tests.
- `bot/`: checkout HTTP client and local cross-system tests against the real website handlers and disposable SQLite.
- `frontend/`: standalone component, poller, and QR tests for the checkout UI; the website serves its integrated page.
- `.github/workflows/checkout-ci.yml`: website tests/typecheck, bot and cross-system tests, frontend tests/typecheck.

Run locally:

```sh
(cd website && bun install --frozen-lockfile && bun test && bun run typecheck)
(cd bot && python -m pip install aiohttp pytest pytest-asyncio && python -m pytest -q)
(cd frontend && bun install --frozen-lockfile && bun test && bun run typecheck)
```

For the live repository state, configuration, staging sequence, acceptance criteria, and rollback, see [the staging runbook](docs/DEPLOYMENT_CHECKLIST.md). The older blocked-work notes have been replaced with a current summary in `docs/WORK_REMAINING_BLOCKED.md`.
