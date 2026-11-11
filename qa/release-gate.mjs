/**
 * Track A (manual-verified UPI) release QA gate. OFFLINE AND READ-ONLY.
 * A green GitHub Actions job must never authorize checkout, funds or GST.
 *
 * Usage:
 *   node qa/release-gate.mjs docs/release/track-a-qa-evidence-2026-11-10.json
 *   node qa/release-gate.mjs --assert-review-eligible <evidence-file>
 *
 * The second command exits nonzero for missing/failed QA and does NOT deploy.
 * Even full QA eligibility still requires a separately signed release record.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_GATES = Object.freeze([
  "main_branch_ci",
  "canonical_website_parity",
  "cloudflare_database_isolation",
  "staging_checkout_schema",
  "deployed_revision_parity",
  "isolated_discord_roles",
  "staged_checkout_negative_matrix",
  "durable_outbox_restart_recovery",
  "independent_bank_receipt_review",
  "privacy_refunds_customer_support",
  "gst_non_gst_invoice_policy",
  "alerts_incident_and_rollback",
  "signed_production_canary",
]);

export const REQUIRED_APPROVALS = Object.freeze([
  "ceo_release_owner",
  "payments_lead",
  "infra_security",
  "operations_support",
  "privacy_legal",
]);

const SHA = /^[0-9a-f]{40}$/;
const statuses = new Set(["passed", "blocked", "failed"]);
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(field) {
  // Never interpolate untrusted evidence into CI error output.
  throw new Error("Invalid release evidence: " + field);
}

function validateHttpsProofs(proofs, field, required) {
  if (!Array.isArray(proofs) || (required && proofs.length === 0) || proofs.length > 12) {
    fail(field);
  }
  for (const url of proofs) {
    if (typeof url !== "string" || url.length > 512) fail(field);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          parsed.search || parsed.hash || !parsed.hostname) fail(field);
    } catch {
      fail(field);
    }
  }
}

export function assessRelease(evidence) {
  if (!isRecord(evidence) || evidence.schema_version !== 1 ||
      evidence.track !== "manual_verified_upi" ||
      typeof evidence.audited_on !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(evidence.audited_on)) fail("metadata");

  if (!isRecord(evidence.source_revisions) ||
      Object.keys(evidence.source_revisions).sort().join(",") !== "bot,pay,website") {
    fail("source_revisions");
  }
  for (const name of ["pay", "website", "bot"]) {
    if (typeof evidence.source_revisions[name] !== "string" ||
        !SHA.test(evidence.source_revisions[name])) fail("source_revisions");
  }

  if (!isRecord(evidence.gates) ||
      Object.keys(evidence.gates).sort().join(",") !== [...REQUIRED_GATES].sort().join(",")) {
    fail("gates_inventory");
  }

  const blockers = [];
  const failures = [];
  for (const id of REQUIRED_GATES) {
    const gate = evidence.gates[id];
    if (!isRecord(gate) || !statuses.has(gate.status)) fail("gate_" + id);
    validateHttpsProofs(gate.evidence, "gate_" + id, gate.status === "passed");
    if (gate.status === "passed") {
      if (typeof gate.reviewer_role !== "string" ||
          gate.reviewer_role.trim().length < 3 ||
          gate.reviewer_role.length > 100) fail("gate_" + id);
    } else {
      if (typeof gate.blocker !== "string" || gate.blocker.trim().length < 12 ||
          gate.blocker.length > 500) fail("gate_" + id);
      blockers.push(id);
      if (gate.status === "failed") failures.push(id);
    }
  }

  if (!isRecord(evidence.approvals) ||
      Object.keys(evidence.approvals).sort().join(",") !== [...REQUIRED_APPROVALS].sort().join(",")) {
    fail("approvals_inventory");
  }
  const missingApprovals = [];
  for (const id of REQUIRED_APPROVALS) {
    const approval = evidence.approvals[id];
    if (!isRecord(approval) ||
        !["pending", "approved"].includes(approval.status)) fail("approval_" + id);
    if (approval.status === "pending") {
      missingApprovals.push(id);
      continue;
    }
    if (typeof approval.approver !== "string" || approval.approver.trim().length < 3 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(approval.approved_on)) fail("approval_" + id);
    validateHttpsProofs(approval.evidence, "approval_" + id, true);
  }

  // No automated "GO" state exists: explicit human production release remains external.
  return {
    decision: blockers.length || missingApprovals.length
      ? "NO_GO" : "AWAITING_SEPARATE_SIGNED_PRODUCTION_RELEASE",
    blockers,
    failures,
    missingApprovals,
    passedCount: REQUIRED_GATES.length - blockers.length,
    totalCount: REQUIRED_GATES.length,
  };
}

export function markdownReport(evidence, assessment) {
  const output = [
    "### Aventas Pay — Track A production QA (read-only)",
    "",
    "**Decision: " + assessment.decision.replaceAll("_", " ") + "**",
    "",
    "Source revision pins: Pay " + evidence.source_revisions.pay.slice(0, 12) +
      ", website " + evidence.source_revisions.website.slice(0, 12) +
      ", bot " + evidence.source_revisions.bot.slice(0, 12) + ".",
    "Audited: " + evidence.audited_on + ".",
    "QA gates passed: " + assessment.passedCount + "/" + assessment.totalCount + ".",
    "Unresolved QA gate IDs: " + (assessment.blockers.join(", ") || "none") + ".",
    "Missing operator approvals: " + (assessment.missingApprovals.join(", ") || "none") + ".",
    "",
    "CI success is engineering evidence only. This report cannot approve deployment,",
    "verify bank settlement, collect GST, switch payment flags or authorize a canary.",
    "Inspect the evidence file and #7 child issues before any production decision.",
  ];
  return output.join("\n") + "\n";
}

function main(argv) {
  const strict = argv[0] === "--assert-review-eligible";
  const args = strict ? argv.slice(1) : argv;
  if (args.length !== 1) fail("usage");
  const evidence = JSON.parse(readFileSync(resolve(args[0]), "utf8"));
  const result = assessRelease(evidence);
  process.stdout.write(markdownReport(evidence, result));
  if (strict && result.decision !== "AWAITING_SEPARATE_SIGNED_PRODUCTION_RELEASE") {
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write("Release QA evidence invalid; fail closed.\n"); process.exitCode = 1; }
}
