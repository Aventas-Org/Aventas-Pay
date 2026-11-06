# Checkout security validation

The checkout workflow tests the canonical TypeScript API, React page, and Python
client together, including a real local HTTP server and SQLite migrations. It
runs on untrusted pull requests with read-only repository permissions and no
payment, deployment, Discord or infrastructure secrets.

## Gates

- Frozen Bun lockfiles; API/frontend typechecking, tests and production UI build.
- Bun advisory audits for both lockfiles and pip-audit for the resolved Python
  runtime/test dependency graph rooted at `bot/requirements-ci.txt`.
- Bandit on production Python client code, blocking medium/high severity findings.
- CodeQL on JavaScript/TypeScript and Python, on PRs, main and weekly.
- Job summary records the tested merge SHA, PR head, tool versions and lockfile
  hashes. This is validation provenance, not a signed build attestation.

Bandit currently reports two low-severity findings: B311 on random retry jitter
(which does not generate tokens or secrets), and B105 on an environment variable
name alias (which contains no secret value). These remain visible in scan output;
there are no dependency-advisory ignore rules. New medium/high findings block CI.

## Limits and issue #21

This is the canonical Pay portion of #21. Website and deployed Discord bot have
independent dependency graphs and must retain their own advisory and SAST gates.
A successful Pay run does not audit those graphs or prove vendored code parity.
Do not close #21 until those repositories have recorded their checks as well.

CI cannot prove deployed Worker/D1 isolation, Discord delivery, durable outbox
recovery, merchant settlement, or operational/legal approval. Issues #8–10,
#15–17 and #19–23 retain their acceptance gates. Production payment flags and GST
remain subject to their existing release controls.

## Measured regression coverage floor (2026-11-06)

The initial coverage-enabled head run of Pay [PR #36](https://github.com/Aventas-Org/Aventas-Pay/pull/36) was green. CI logs reported:

| Surface | Tests | Function coverage | Line coverage | Minimum per-file functions | Minimum per-file lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| Canonical checkout Worker/API TypeScript | 141 passed, 0 failed | 97.40% | 99.33% | 75% | 90% |
| Standalone checkout UI/QR/poller | 44 passed, 0 failed | 95.91% | 99.07% | 80% | 90% |

`bun test --coverage` enforces the configured thresholds per file and fails CI if a covered file falls below the floor. The thresholds deliberately leave headroom for error-path work and include test helper modules where Bun includes them. Coverage numbers are **unit/integration-in-process metrics**, not evidence of browser compatibility, Cloudflare staging, Discord guild behavior, correct settlement or legal compliance. Baseline is not an authorization to activate hosted checkout.

## Merchant receipt reference privacy (2026-11-06)

The canonical checkout Worker verification handler records a `provider_transaction_ref`
for idempotent state changes. It must remain accessible **only** in the
restricted persistence/audit path, not operational Worker logs, shared CI or
public issue descriptions. The structured logger masks this key and common
provider/bank aliases regardless of value length, including four-character
references that the generic 40-character bearer heuristic misses. Regression
tests exercise the actual trusted verify handler, the in-memory capture logger
and JSON console output. No payment-state logic or stored reference changes.
The website must import the exact canonical logger file through its pinned
22-file vendor manifest; this is not a substitute for merchant-approved
receipt retention and access policies under Pay #22.
