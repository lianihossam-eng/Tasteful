import { rejectsWithCode } from "../assert-code.js";
/** Human re-review clears stale/invalidated only after re-hashing artifacts. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { computeAuthoredContentHash, sha256Hex } from "../../src/design/hashes.js";
import type { Decision, Gate } from "../../src/design/schema.js";
import {
  initProject,
  readDecision,
  writeDecisionRecord,
  type ProjectPaths,
} from "../../src/design/store.js";
import {
  artifactValidate,
  decisionInvalidate,
  decisionUpsert,
  grantAcceptApproval,
  makeToolContext,
} from "../../src/host/tools.js";
import { cmdAccept, cmdDecisionCreate } from "../../src/cli/commands.js";
import { decisionBase, installApprovedGate, seedPassingValidationRecord, tempDir, writeJson } from "../helpers.js";

const OWNER = "designer@example";
const APPROVER = "lead@example";
const GATE_ID = "G-DESIGN-REVIEW";
const DAY = "2026-11-11";
const ARTIFACT_BYTES = "artifact-v1";
const EVIDENCE_BYTES = "review evidence";
const CLAIM = {
  claim_id: "C-PLATFORM-MOBILE",
  subject: "platform.mobile",
  predicate: "is",
  value: "mobile-web",
  scope: "project",
};

const PASS_GATE: Gate = {
  gate_id: GATE_ID,
  stage: "visual-system",
  checklist: [
    { criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: DAY },
  ],
  decision: "pass",
  approver: APPROVER,
  owner: OWNER,
  waivers: [],
};

interface Fixture {
  dir: string;
  p: ProjectPaths;
  artifactSha: string;
  evidenceSha: string;
}

async function setup(prefix = "tasteful-rereview-"): Promise<Fixture> {
  const dir = await tempDir(prefix);
  const p = await initProject(dir, "rereview", "0.1.0");
  await fs.writeFile(path.join(dir, "art.bin"), ARTIFACT_BYTES, "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), EVIDENCE_BYTES, "utf8");
  await installApprovedGate(p, PASS_GATE);
  const artifactSha = sha256Hex(ARTIFACT_BYTES);
  await seedPassingValidationRecord(p, {
    decisionId: "D001",
    artifactPath: "art.bin",
    sha256: artifactSha,
    checks: ["opens"],
  });
  return { dir, p, artifactSha, evidenceSha: sha256Hex(EVIDENCE_BYTES) };
}

function ctxFor(dir: string, actor: "agent" | "human" = "human") {
  return makeToolContext(dir, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, actor);
}

function acceptedDecision(id: string, f: Fixture, overrides?: Partial<Decision>): Decision {
  return decisionBase(id, {
    status: "accepted",
    owner: OWNER,
    gate_ref: GATE_ID,
    claims: [CLAIM],
    evidence: [{ type: "review", ref: "evidence.md", sha256: f.evidenceSha, captured_at: DAY }],
    artifacts: [
      {
        path: "art.bin",
        sha256: f.artifactSha,
        validator_version: 1,
        validated_at: new Date().toISOString(),
        checks: ["opens"],
        ready: true,
      },
    ],
    ...overrides,
  });
}

/** Authored projection of a stored record (drops derived fields). */
function authored(d: Decision): Decision {
  const { review_state: _rs, decision_hash: _h, ...rest } = d;
  void _rs;
  void _h;
  return rest as Decision;
}

async function acceptAndStore(f: Fixture, d: Decision): Promise<void> {
  const { digest } = await grantAcceptApproval(f.p, {
    decision_id: d.id,
    owner: d.owner,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(d),
  });
  await decisionUpsert(ctxFor(f.dir), { decision: d, approval_id: digest });
}

async function refreshed(d: Decision): Promise<Decision> {
  const a = authored(d);
  return { ...a, artifacts: a.artifacts.map((art) => ({ ...art, ready: true })) };
}

test("invalidated accepted decision re-reviews to current with a fresh content approval", async () => {
  const f = await setup();
  const d = acceptedDecision("D001", f);
  await acceptAndStore(f, d);
  assert.equal((await readDecision(f.p, "D001")).review_state, "current");

  const inv = await decisionInvalidate(ctxFor(f.dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: OWNER,
  });
  assert.equal(inv.affected.D001, "invalidated");
  const invalidated = await readDecision(f.p, "D001");
  assert.equal(invalidated.review_state, "invalidated");
  assert.equal(invalidated.artifacts[0].ready, false);

  const next = await refreshed(invalidated);
  await acceptAndStore(f, next);
  const current = await readDecision(f.p, "D001");
  assert.equal(current.review_state, "current");
  assert.equal(current.status, "accepted");
  assert.equal(current.artifacts[0].ready, true);
});

test("re-review without approval is rejected and artifact_validate OK does not clear state", async () => {
  const f = await setup();
  await acceptAndStore(f, acceptedDecision("D001", f));
  await decisionInvalidate(ctxFor(f.dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: OWNER,
  });
  const invalidated = await readDecision(f.p, "D001");
  await writeDecisionRecord(f.p, { ...invalidated, review_state: "needs_review" });
  const next = await refreshed(await readDecision(f.p, "D001"));

  await rejectsWithCode(
    decisionUpsert(ctxFor(f.dir), { decision: next }),
    "E_ACCEPT_NO_APPROVAL",
  );
  assert.equal((await readDecision(f.p, "D001")).review_state, "needs_review");

  const res = await artifactValidate(ctxFor(f.dir), { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(res.ok, true);
  const afterValidate = await readDecision(f.p, "D001");
  assert.equal(afterValidate.review_state, "needs_review");
  // A fresh passing validation record makes the artifact ready, but the
  // decision-level re-review state is unchanged until a human accepts again.
  assert.equal(afterValidate.artifacts[0].ready, true);
});

test("stale accepted decision re-reviews to current through CLI accept --file + decision create", async () => {
  const f = await setup();
  const d = acceptedDecision("D001", f);
  await acceptAndStore(f, d);
  const stored = await readDecision(f.p, "D001");
  await writeDecisionRecord(f.p, {
    ...stored,
    review_state: "stale",
    artifacts: stored.artifacts.map((a) => ({ ...a, ready: false })),
  });
  assert.equal((await readDecision(f.p, "D001")).review_state, "stale");

  const next = await refreshed(stored);
  const file = path.join(f.dir, "D001-accepted.json");
  await writeJson(file, next);
  const digest = (await cmdAccept({ project: f.dir }, { file }, APPROVER)).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.match(await cmdDecisionCreate({ project: f.dir }, file, digest), /^D001 v1 /);

  const current = await readDecision(f.p, "D001");
  assert.equal(current.review_state, "current");
  assert.equal(current.artifacts[0].ready, true);
});

test("needs_review accepted decision re-reviews to current after drift is repaired", async () => {
  const f = await setup();
  await acceptAndStore(f, acceptedDecision("D001", f));

  await fs.appendFile(path.join(f.dir, "art.bin"), "drift", "utf8");
  const drift = await artifactValidate(ctxFor(f.dir), { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(drift.ok, false);
  const flagged = await readDecision(f.p, "D001");
  assert.equal(flagged.status, "proposed"); // H12 demotion
  assert.equal(flagged.review_state, "needs_review");
  assert.equal(flagged.artifacts[0].ready, false);

  const repairedSha = sha256Hex(ARTIFACT_BYTES + "drift");
  await seedPassingValidationRecord(f.p, {
    decisionId: "D001",
    artifactPath: "art.bin",
    sha256: repairedSha,
    checks: ["opens"],
  });
  const next: Decision = {
    ...authored(flagged),
    status: "accepted",
    artifacts: [{ ...flagged.artifacts[0], sha256: repairedSha, checks: ["opens"], ready: true }],
  };
  await acceptAndStore(f, next);
  const current = await readDecision(f.p, "D001");
  assert.equal(current.status, "accepted");
  assert.equal(current.review_state, "current");
  assert.equal(current.artifacts[0].ready, true);
  assert.equal(current.artifacts[0].sha256, repairedSha);
});

test("re-review refuses when the artifact drifted after approval", async () => {
  const f = await setup();
  await acceptAndStore(f, acceptedDecision("D001", f));
  await decisionInvalidate(ctxFor(f.dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: OWNER,
  });
  await fs.appendFile(path.join(f.dir, "art.bin"), "drift", "utf8");
  const next = await refreshed(await readDecision(f.p, "D001"));
  const { digest } = await grantAcceptApproval(f.p, {
    decision_id: "D001",
    owner: next.owner,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(next),
  });
  await rejectsWithCode(
    decisionUpsert(ctxFor(f.dir), { decision: next, approval_id: digest }),
    "E_ACCEPT_NO_ARTIFACT",
  );
  const unchanged = await readDecision(f.p, "D001");
  assert.equal(unchanged.review_state, "invalidated");
  assert.equal(unchanged.artifacts[0].ready, false);
});

test("failed invalidation leaves no event file and no consumed event id", async () => {
  const f = await setup();
  const d = decisionBase("D001", { claims: [CLAIM] });
  await decisionUpsert(ctxFor(f.dir), { decision: d });

  await rejectsWithCode(
    decisionInvalidate(ctxFor(f.dir), {
      claim_id: "C-UNKNOWN",
      old_value: "a",
      new_value: "b",
      reason: "no such claim",
      author: OWNER,
    }),
    "E_CLAIM_UNKNOWN",
  );
  assert.deepEqual(await fs.readdir(f.p.events), []);

  const ok = await decisionInvalidate(ctxFor(f.dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: OWNER,
  });
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(ok.event_id, `E-${day}-001`);
  assert.deepEqual(await fs.readdir(f.p.events), [`E-${day}-001.json`]);
});
