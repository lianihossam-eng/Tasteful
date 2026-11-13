/**
 * Journal preflight: every state-changing path verifies the journal inside
 * its locked critical section BEFORE consuming approvals or mutating state,
 * so a corrupt/symlinked journal cannot commit an unjournaled change.
 */
import { rejectsWithCode } from "../assert-code.js";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { computeAuthoredContentHash, computeGateContentHash, sha256Hex } from "../../src/design/hashes.js";
import { validateGate } from "../../src/design/schema.js";
import { initProject, readDecision, withLock, type ProjectPaths } from "../../src/design/store.js";
import { readApprovalRecord, grantApproval } from "../../src/host/approvals.js";
import { appendJournal } from "../../src/host/journal.js";
import {
  artifactValidate,
  decisionInvalidate,
  decisionUpsert,
  fsWrite,
  gateUpsert,
  grantAcceptApproval,
  grantGateApproval,
  resolveProjectPath,
} from "../../src/host/tools.js";
import { cmdBrief, makeCtx } from "../../src/cli/commands.js";
import { decisionBase, tempDir } from "../helpers.js";

const CLAIM = {
  claim_id: "C-PLATFORM-MOBILE",
  subject: "platform.mobile",
  predicate: "is",
  value: "mobile-web",
  scope: "project",
};

const PASS_GATE = {
  gate_id: "G-DESIGN-REVIEW",
  stage: "visual-system",
  checklist: [
    {
      criterion: "contrast AA",
      evidence_ref: "artifacts/contrast.json",
      verifier_role: "accessibility",
      verdict: "pass" as const,
      date: "2026-11-11",
    },
  ],
  decision: "pass" as const,
  approver: "lead@example",
  owner: "designer@example",
  waivers: [],
};

async function fresh(prefix: string) {
  const dir = await tempDir(prefix);
  const p = await initProject(dir, "preflight", "0.1.0");
  const tc = makeCtx(dir);
  await withLock(p, async () => {
    await appendJournal(p, tc.journal, { kind: "command", actor: "human", payload: { command: "init" } });
  });
  const leaf = path.join(p.journal, "run.jsonl");
  const outside = path.join(dir, "outside.jsonl");
  return { dir, p, tc, leaf, outside };
}

/** Replace the journal leaf with a symlink to an outside file. */
async function corruptLeaf(leaf: string, outside: string): Promise<void> {
  await fs.writeFile(outside, "ORIGINAL-OUTSIDE\n", "utf8");
  await fs.rm(leaf);
  await fs.symlink(outside, leaf);
}

async function assertOutsideUntouched(outside: string): Promise<void> {
  assert.equal(await fs.readFile(outside, "utf8"), "ORIGINAL-OUTSIDE\n");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function used(p: ProjectPaths, digest: string): Promise<boolean> {
  return (await readApprovalRecord(p, digest)).record.used;
}

test("fsWrite preflights before approval consumption and the write", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-fs-");
  const target = await resolveProjectPath(tc, "ok.txt");
  const rec = await grantApproval(p, {
    tool: "fs_write",
    target,
    content: "NEW",
    params: { path: "ok.txt" },
    approver: "op@example",
  });
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(fsWrite(tc, { path: "ok.txt", content: "NEW" }), "E_JOURNAL_LEAF");
  assert.equal(await used(p, rec.digest), false);
  assert.equal(await exists(path.join(dir, "ok.txt")), false);
  await assertOutsideUntouched(outside);
});

test("decisionUpsert preflights before approval consumption and the record write", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-decision-");
  const d = decisionBase("D0001");
  const { digest } = await grantAcceptApproval(p, {
    decision_id: d.id,
    owner: d.owner,
    approver: "lead@example",
    contentHash: computeAuthoredContentHash(d),
  });
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(decisionUpsert(tc, { decision: d, approval_id: digest }), "E_JOURNAL_LEAF");
  assert.equal(await used(p, digest), false);
  assert.equal(await exists(path.join(p.decisions, "D0001.json")), false);
  await assertOutsideUntouched(outside);
});

test("gateUpsert preflights before approval consumption and the gate write", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-gate-");
  const g = validateGate(PASS_GATE);
  const { digest } = await grantGateApproval(p, {
    gate_id: g.gate_id,
    owner: g.owner,
    approver: g.approver,
    contentHash: computeGateContentHash(g),
  });
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(gateUpsert(tc, { gate: PASS_GATE, approval_id: digest }), "E_JOURNAL_LEAF");
  assert.equal(await used(p, digest), false);
  assert.equal(await exists(path.join(p.gates, `${g.gate_id}.json`)), false);
  await assertOutsideUntouched(outside);
});

test("decisionInvalidate preflights before writing the event", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-invalidate-");
  await decisionUpsert(tc, { decision: decisionBase("D0001", { claims: [CLAIM] }) });
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(
    decisionInvalidate(tc, {
      claim_id: CLAIM.claim_id,
      old_value: "mobile-web",
      new_value: "mobile-web+ios",
      reason: "scope change",
      author: "designer@example",
    }),
    "E_JOURNAL_LEAF",
  );
  const events = await fs.readdir(p.events);
  assert.deepEqual(events.filter((e) => e.endsWith(".json")), []);
  assert.equal((await readDecision(p, "D0001")).review_state, "current");
  await assertOutsideUntouched(outside);
});

test("artifactValidate preflights before writing a validation record or decision", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-artifact-");
  await fs.writeFile(path.join(dir, "art.bin"), "artifact", "utf8");
  await decisionUpsert(tc, {
    decision: decisionBase("D0001", {
      artifacts: [
        {
          path: "art.bin",
          sha256: sha256Hex("artifact"),
          validator_version: 1,
          validated_at: "2026-11-11",
          checks: ["opens"],
          ready: false,
        },
      ],
    }),
  });
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(
    artifactValidate(tc, { decision_id: "D0001", artifact_path: "art.bin" }),
    "E_JOURNAL_LEAF",
  );
  const records = await fs.readdir(p.validations);
  assert.deepEqual(records, []);
  assert.equal((await readDecision(p, "D0001")).artifacts[0]!.ready, false);
  await assertOutsideUntouched(outside);
});

test("cmdBrief preflights before writing brief.md and coverage.json", async () => {
  const { dir, p, tc, leaf, outside } = await fresh("tasteful-preflight-brief-");
  const briefFile = path.join(dir, "brief-input.md");
  const coverageFile = path.join(dir, "coverage-input.json");
  await fs.writeFile(briefFile, "# Brief\nMobile checkout first.\n", "utf8");
  await fs.writeFile(
    coverageFile,
    JSON.stringify({
      brief_id: "B-001",
      platforms: ["mobile-390"],
      screens: [{ screen: "checkout-payment", states: ["default", "error", "loading", "empty"], breakpoints: ["mobile-390"], decision: "in", rationale: "critical flow" }],
    }),
    "utf8",
  );
  await corruptLeaf(leaf, outside);
  await rejectsWithCode(cmdBrief({ project: dir }, briefFile, coverageFile), "E_JOURNAL_LEAF");
  assert.equal(await exists(path.join(p.tasteful, "brief.md")), false);
  assert.equal(await exists(path.join(p.tasteful, "coverage.json")), false);
  await assertOutsideUntouched(outside);
});
