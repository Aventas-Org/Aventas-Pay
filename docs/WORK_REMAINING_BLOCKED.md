# Checkout integration: current remaining work

The earlier version of this file was written before the website and bot repositories were accessible. It is historical and must not be used as current integration status.

As of the cross-repository audit, website `main` mounts the checkout router and hosts `/checkout/:token`; bot `main` includes the optional checkout link patch, checkout client, and trusted-payment website hook. Website PR #91 is merged into `main`. The Pay core's TypeScript source and migrations are compared with the website copy in the audit PRs. The bot feature flag remains disabled by default.

Outstanding work is operational: review and merge the focused PRs, obtain an isolated staging Worker/D1 and secrets, run the staging contract and customer journey checks in `DEPLOYMENT_CHECKLIST.md`, inspect CI and deployments for the exact merged commits, then separately approve production provisioning and activation. The prior read-only inventory found the production checkout D1 tables and Worker/bot bindings absent; recheck the live resources before relying on that inventory. No production migration, secret, variable, merge, or deployment is part of this audit.
