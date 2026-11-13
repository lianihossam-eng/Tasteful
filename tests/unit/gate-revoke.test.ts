import { rejectsWithCode } from "../assert-code.js";
/** Human gate revoke: non-pass revocation, dependent demotion, fresh approval chain. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { Decision, Gate } from "../../src/design/schema.js";
import { sha256Hex } from "../../src/design/hashes.js";
import { initProject, readDecision, readGate, type ProjectPaths } from "../../src/design/store.js";
import { readJournalEntries } from "../../src/host/journal.js";
import {
  cmdAccept,
  cmdDecisionCreate,
  cmdGateAccept,
  cmdGateCreate,
  cmdGateRevoke,
  cmdStatus,
  makeCtx,
} from "../../src/cli/commands.js";
import { gateRevoke } from "../../src/host/tools.js";
import { decisionBase, seedPassingValidationRecord, tempDir, writeJson } from "../helpers.js";

const OWNER = "designer@example";
const APPROVER = "lead@example";
const GATE_ID = "G-DESIGN-REVIEW";
const DAY = "2026-11-11";

function passGate(): Gate {
  return {
    gate_id: GATE_ID,
    stage: "visual-system",
    checklist: [
      {
        criterion: "contrast AA",
        evidence_ref: "artifacts/contrast.json",
        verifier_role: "accessibility",
        verdict: "pass",
        date: DAY,
      },
    ],
    decision: "pass",
    approver: APPROVER,
    owner: OWNER,
    waivers: [],
  };
}

function acceptedDecision(): Decision {
  return decisionBase("D001", {
    status: "accepted",
    owner: OWNER,
    gate_ref: GATE_ID,
    evidence: [
      { type: "review", ref: "evidence.md", sha256: sha256Hex("evidence"), captured_at: DAY },
    ],
    artifacts: [
      {
        path: "art.bin",
        sha256: sha256Hex("artifact"),
        validator_version: 1,
        validated_at: new Date().toISOString(),
        checks: ["opens"],
        ready: true,
      },
    ],
  });
}

interface Fixture {
  dir: string;
  p: ProjectPaths;
  gateFile: string;
  decisionFile: string;
  g: { project: string };
}

async function setup(): Promise<Fixture> {
  const dir = await tempDir("tasteful-revoke-");
  const p = await initProject(dir, "revoke", "0.1.0");
  await fs.writeFile(path.join(dir, "art.bin"), "artifact", "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), "evidence", "utf8");
  await seedPassingValidationRecord(p, {
    decisionId: "D001",
    artifactPath: "art.bin",
    sha256: sha256Hex("artifact"),
    checks: ["opens"],
  });
  const gateFile = path.join(dir, "gate.json");
  await writeJson(gateFile, passGate());
  const g = { project: dir };
  const gateApproval = (await cmdGateAccept(g, { file: gateFile }, APPROVER)).trim();
  await cmdGateCreate(g, gateFile, gateApproval);
  assert.equal((await readGate(p, GATE_ID)).decision, "pass");

  const decisionFile = path.join(dir, "D001.json");
  await writeJson(decisionFile, acceptedDecision());
  const decisionApproval = (await cmdAccept(g, { file: decisionFile }, APPROVER)).trim();
  await cmdDecisionCreate(g, decisionFile, decisionApproval);
  const stored = await readDecision(p, "D001");
  assert.equal(stored.status, "accepted");
  assert.equal(stored.review_state, "current");
  return { dir, p, gateFile, decisionFile, g };
}

test("human revoke flips the gate, demotes accepted dependents, and journals the transition", async () => {
  const f = await setup();
  // A proposed decision citing the gate is not an accepted dependent.
  const proposedFile = path.join(f.dir, "D002.json");
  await writeJson(proposedFile, decisionBase("D002", { status: "proposed", gate_ref: GATE_ID }));
  await cmdDecisionCreate(f.g, proposedFile);

  await rejectsWithCode(cmdGateRevoke(f.g, GATE_ID, OWNER), "E_SELF_APPROVAL");
  assert.equal((await readGate(f.p, GATE_ID)).decision, "pass");

  const out = await cmdGateRevoke(f.g, GATE_ID, APPROVER);
  assert.match(out, /^G-DESIGN-REVIEW revoked demoted=D001$/m);

  const gate = await readGate(f.p, GATE_ID);
  assert.equal(gate.decision, "revoked");
  const dependent = await readDecision(f.p, "D001");
  assert.equal(dependent.status, "proposed");
  assert.equal(dependent.review_state, "needs_review");
  assert.ok(dependent.artifacts.every((a) => a.ready === false), "artifacts must not be ready");
  const proposed = await readDecision(f.p, "D002");
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.review_state, "current");

  const status = JSON.parse(await cmdStatus(f.g, true)) as {
    gates: Array<{ gate_id: string; decision: string }>;
  };
  assert.deepEqual(status.gates, [{ gate_id: GATE_ID, decision: "revoked" }]);

  const journal = await readJournalEntries(f.p);
  const revokeEvents = journal.filter((e) => e.payload.event === "gate_revoke");
  assert.equal(revokeEvents.length, 1);
  assert.deepEqual(revokeEvents[0].payload, {
    event: "gate_revoke",
    gate_id: GATE_ID,
    approver: APPROVER,
    demoted: ["D001"],
  });
  assert.equal(revokeEvents[0].actor, "human");

  // Already-revoked gates cannot be revoked twice.
  await rejectsWithCode(cmdGateRevoke(f.g, GATE_ID, APPROVER), "E_GATE_BLOCKED");

  // Re-acceptance needs a fresh gate pass: the revoked gate is not passable.
  const staleApproval = (await cmdAccept(f.g, { file: f.decisionFile }, APPROVER)).trim();
  await rejectsWithCode(cmdDecisionCreate(f.g, f.decisionFile, staleApproval), "E_GATE_BLOCKED");
  assert.equal((await readDecision(f.p, "D001")).status, "proposed");

  // Re-pass the gate with a fresh gate_accept approval...
  const gateApproval = (await cmdGateAccept(f.g, { file: f.gateFile }, APPROVER)).trim();
  await cmdGateCreate(f.g, f.gateFile, gateApproval);
  const rePassed = await readGate(f.p, GATE_ID);
  assert.equal(rePassed.decision, "pass");
  assert.match(rePassed.approval_digest ?? "", /^[0-9a-f]{64}$/);

  // ...then the decision content changes need their own fresh approval. The
  // title edit makes the approval digest distinct from every earlier grant.
  const reworkFile = path.join(f.dir, "D001-reworked.json");
  await writeJson(reworkFile, { ...acceptedDecision(), title: "Decision D001 after gate re-pass" });
  const freshApproval = (await cmdAccept(f.g, { file: reworkFile }, APPROVER)).trim();
  assert.notEqual(freshApproval, staleApproval);
  await cmdDecisionCreate(f.g, reworkFile, freshApproval);
  const reAccepted = await readDecision(f.p, "D001");
  assert.equal(reAccepted.status, "accepted");
  assert.equal(reAccepted.review_state, "current");
  assert.ok(reAccepted.artifacts.every((a) => a.ready === true));
});

test("revoke self-check uses canonical identity; local-part case is a different identity", async () => {
  const f = await setup();
  // Direct tool call bypasses CLI normalization: the tool must still compare
  // canonically before demoting anything.
  await rejectsWithCode(
    gateRevoke(makeCtx(f.dir, "human"), { gate_id: GATE_ID, approver: " designer@example " }),
    "E_SELF_APPROVAL",
  );
  await rejectsWithCode(cmdGateRevoke(f.g, GATE_ID, " designer@example "), "E_SELF_APPROVAL");
  await rejectsWithCode(cmdGateRevoke(f.g, GATE_ID, "designer@EXAMPLE"), "E_SELF_APPROVAL");
  assert.equal((await readGate(f.p, GATE_ID)).decision, "pass");
  // Email local-part case is significant: this is a distinct approver.
  const out = await cmdGateRevoke(f.g, GATE_ID, "Designer@example");
  assert.match(out, /^G-DESIGN-REVIEW revoked demoted=D001$/m);
});

test("only a stored pass gate can be revoked", async () => {
  const dir = await tempDir("tasteful-revoke-");
  await initProject(dir, "revoke", "0.1.0");
  const g = { project: dir };
  const file = path.join(dir, "pending.json");
  await writeJson(file, { ...passGate(), decision: "pending" });
  await cmdGateCreate(g, file);
  await rejectsWithCode(cmdGateRevoke(g, GATE_ID, APPROVER), "E_GATE_BLOCKED");
  await rejectsWithCode(cmdGateRevoke(g, "G-MISSING", APPROVER), "E_GATE_BLOCKED");
});
