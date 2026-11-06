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
