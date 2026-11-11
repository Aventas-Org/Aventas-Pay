import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  REQUIRED_APPROVALS, REQUIRED_GATES, assessRelease, markdownReport,
} from "./release-gate.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../docs/release/track-a-qa-evidence-2026-11-10.json", import.meta.url),
  "utf8",
));
const copy = () => structuredClone(fixture);

test("audited Track A is a NO_GO with every required gate and approval accounted for", () => {
  const result = assessRelease(copy());
  assert.equal(REQUIRED_GATES.length, 13);
  assert.equal(REQUIRED_APPROVALS.length, 5);
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.totalCount, 13);
  assert.equal(result.passedCount, 4);
  assert.equal(result.blockers.length, 9);
  assert.equal(result.missingApprovals.length, 5);
  const report = markdownReport(fixture, result);
  assert.match(report, /NO GO/);
  assert.match(report, /bank_receipt_review/);
  assert.doesNotMatch(report, /PAYMENT_API_SECRET=/);
});

test("missing, extra or typoed gates fail closed", () => {
  const missing = copy(); delete missing.gates.durable_outbox_restart_recovery;
  assert.throws(() => assessRelease(missing), /gates_inventory/);
  const extra = copy(); extra.gates.fake_release_approval = { status: "passed" };
  assert.throws(() => assessRelease(extra), /gates_inventory/);
});

test("a passing gate must carry HTTPS evidence and a reviewer role", () => {
  const noProof = copy(); noProof.gates.main_branch_ci.evidence = [];
  assert.throws(() => assessRelease(noProof), /gate_main_branch_ci/);
  const urlWithSecret = copy();
  urlWithSecret.gates.main_branch_ci.evidence = ["https://example.com/a?token=sensitive"];
  assert.throws(() => assessRelease(urlWithSecret), /gate_main_branch_ci/);
  const noReviewer = copy(); noReviewer.gates.main_branch_ci.reviewer_role = "";
  assert.throws(() => assessRelease(noReviewer), /gate_main_branch_ci/);
});

test("invalid revision pins or fabricated gate states fail closed", () => {
  const badRevision = copy(); badRevision.source_revisions.website = "main";
  assert.throws(() => assessRelease(badRevision), /source_revisions/);
  const fake = copy(); fake.gates.staged_checkout_negative_matrix.status = "approved";
  assert.throws(() => assessRelease(fake), /gate_staged_checkout_negative_matrix/);
  const noReason = copy(); noReason.gates.staged_checkout_negative_matrix.blocker = "";
  assert.throws(() => assessRelease(noReason), /gate_staged_checkout_negative_matrix/);
});

test("all QA passing does not count as legal, payments or CEO approval", () => {
  const candidate = copy();
  for (const id of REQUIRED_GATES) {
    candidate.gates[id] = {
      status: "passed",
      reviewer_role: "QA reviewer",
      evidence: ["https://github.com/Aventas-Org/Aventas-Pay/issues/7"],
    };
  }
  const result = assessRelease(candidate);
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.missingApprovals.length, 5);
});

test("even all accepted evidence only awaits a separate signed production record", () => {
  const candidate = copy();
  for (const id of REQUIRED_GATES) {
    candidate.gates[id] = {
      status: "passed",
      reviewer_role: "QA reviewer",
      evidence: ["https://github.com/Aventas-Org/Aventas-Pay/issues/7"],
    };
  }
  for (const id of REQUIRED_APPROVALS) {
    candidate.approvals[id] = {
      status: "approved",
      approver: "named authorized reviewer",
      approved_on: "2026-11-10",
      evidence: ["https://github.com/Aventas-Org/Aventas-Pay/issues/7"],
    };
  }
  assert.equal(
    assessRelease(candidate).decision, "AWAITING_SEPARATE_SIGNED_PRODUCTION_RELEASE",
  );
});

test("assert-review-eligible exits nonzero on outstanding payment acceptance", () => {
  const output = spawnSync(process.execPath, [
    new URL("./release-gate.mjs", import.meta.url).pathname,
    "--assert-review-eligible",
    new URL("../docs/release/track-a-qa-evidence-2026-11-10.json", import.meta.url).pathname,
  ], { encoding: "utf8" });
  assert.equal(output.status, 2);
  assert.match(output.stdout, /NO GO/);
});
