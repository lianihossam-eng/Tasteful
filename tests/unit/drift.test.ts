/** Artifact hash drift: owner + transitive dependents, readiness, H12 status. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { gatePasses } from "../../src/design/gates.js";
import { sha256Hex } from "../../src/design/hashes.js";
import type { Decision, Gate } from "../../src/design/schema.js";
import {
  initProject,
  readDecision,
  readGate,
  upsertDecision,
  writeGate,
  type ProjectPaths,
} from "../../src/design/store.js";
import { appendJournal, readJournalEntries } from "../../src/host/journal.js";
import { artifactValidate, makeToolContext } from "../../src/host/tools.js";
import { decisionBase, tempDir } from "../helpers.js";

const DAY = new Date().toISOString().slice(0, 10);
const OWNER = "designer@example";
const LEAD = "lead@example";

const PASSING_GATE: Gate = {
  gate_id: "G-DESIGN-REVIEW",
  stage: "design-review",
  checklist: [{
    criterion: "visual review",
    evidence_ref: "reviews/design.md",
    verifier_role: "lead",
    verdict: "pass",
    date: DAY,
  }],
  decision: "pass",
  approver: LEAD,
  owner: OWNER,
  waivers: [],
};

async function setupProject(): Promise<{ dir: string; project: ProjectPaths; artifactFile: string; artifactSha: string }> {
  const dir = await tempDir("tasteful-drift-");
  const p = await initProject(dir, "drift", "0.1.0");
  // Real history exists before state; preflight rejects hand-written state with
  // a missing journal, so start the chain with a valid seq-1 entry.
  const journalCtx = makeToolContext(dir, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }).journal;
  await appendJournal(p, journalCtx, { kind: "command", actor: "human", payload: { command: "init" } });
  const artifactFile = path.join(dir, "art.bin");
  await fs.writeFile(artifactFile, "artifact-v1", "utf8");
  const artifactSha = sha256Hex("artifact-v1");
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  await fs.writeFile(path.join(dir, "reviews", "design.md"), "review", "utf8");
  await writeGate(p, PASSING_GATE);

  const accepted: Decision = decisionBase("D001", {
    status: "accepted",
    gate_ref: "G-DESIGN-REVIEW",
    evidence: [{ type: "review", ref: "reviews/design.md", sha256: sha256Hex("review") }],
    artifacts: [{
      path: "art.bin",
      sha256: artifactSha,
      validator_version: 1,
      validated_at: DAY,
      checks: ["opens"],
      ready: true,
    }],
  });
  const opts = {
    approvalId: "test-approval",
    approvalValid: async () => true,
    gatePasses: async (ref: string) => gatePasses(await readGate(p, ref)),
    validateArtifact: async (a: { path: string; sha256: string }) => {
      const actual = sha256Hex(await fs.readFile(path.join(dir, a.path)));
      if (actual !== a.sha256) throw new Error("E_ACCEPT_NO_ARTIFACT: artifact hash mismatch");
    },
    validateEvidence: async (e: { ref: string; sha256?: string }) => {
      const actual = sha256Hex(await fs.readFile(path.join(dir, e.ref)));
      if (actual !== e.sha256) throw new Error("E_ACCEPT_NO_EVIDENCE: evidence hash mismatch");
    },
  };
  await upsertDecision(p, accepted, opts);

  await upsertDecision(p, decisionBase("D002", {
    status: "accepted",
    gate_ref: "G-DESIGN-REVIEW",
    evidence: [{ type: "review", ref: "reviews/design.md", sha256: sha256Hex("review") }],
    depends_on: ["D001"],
    artifacts: [{
      path: "art.bin",
      sha256: artifactSha,
      validator_version: 1,
      validated_at: DAY,
      checks: ["opens"],
      ready: true,
    }],
  }), opts);
  await upsertDecision(p, decisionBase("D003", {
    depends_on: ["D002"],
    artifacts: [{
      path: "art.bin",
      sha256: artifactSha,
      validator_version: 1,
      validated_at: DAY,
      checks: ["opens"],
      ready: true,
    }],
  }), opts);
  await upsertDecision(p, decisionBase("D004", {
    artifacts: [{
      path: "art.bin",
      sha256: artifactSha,
      validator_version: 1,
      validated_at: DAY,
      checks: ["opens"],
      ready: true,
    }],
  }), opts);
  return { dir, project: p, artifactFile, artifactSha };
}

function ctxFor(root: string) {
  return makeToolContext(root, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "human");
}

test("drift demotes accepted owner, flags every transitive dependent, clears ready", async () => {
  const { dir, project: p, artifactFile, artifactSha } = await setupProject();
  // Fresh fixture: the dependent is current before the mutation.
  assert.equal((await readDecision(p, "D002")).review_state, "current");
  assert.equal((await readDecision(p, "D002")).status, "accepted");

  await fs.appendFile(artifactFile, "x", "utf8");
  const res = await artifactValidate(ctxFor(dir), { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(res.ok, false);
  assert.equal(res.drifted, true);
  assert.equal(res.expected, artifactSha);
  assert.notEqual(res.actual, artifactSha);
  assert.deepEqual(res.affected, ["D001", "D002", "D003"]);

  const owner = await readDecision(p, "D001");
  assert.equal(owner.status, "proposed"); // H12: must not remain accepted
  assert.equal(owner.review_state, "needs_review");
  assert.equal(owner.artifacts[0].ready, false);
  assert.ok(owner.artifacts[0].validated_at?.startsWith(DAY));
  assert.deepEqual(owner.artifacts[0].checks, ["sha256"]);

  for (const id of ["D002", "D003"]) {
    const d = await readDecision(p, id);
    assert.equal(d.review_state, "needs_review", `${id} must be flagged`);
    if (id === "D002") assert.equal(d.status, "proposed", "accepted dependent must be demoted");
    for (const artifact of d.artifacts) assert.equal(artifact.ready, false, `${id} artifact ready must clear`);
  }

  // Outside the reverse dependency chain: untouched.
  const unrelated = await readDecision(p, "D004");
  assert.equal(unrelated.status, "proposed");
  assert.equal(unrelated.review_state, "current");
  assert.equal(unrelated.artifacts[0].ready, true);

  const journal = await readJournalEntries(p);
  const drift = journal[journal.length - 1];
  assert.equal(drift.payload.tool, "artifact_validate");
  assert.equal(drift.payload.drifted, true);
  assert.deepEqual(drift.payload.affected, ["D001", "D002", "D003"]);
  assert.deepEqual(await fs.readdir(p.validations), [], "drift must not write a validation record");
});

test("matching hash leaves accepted/current/ready untouched", async () => {
  const { project: p } = await setupProject();
  const res = await artifactValidate(ctxFor(p.root), { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ name: "opens", verdict: "pass", detail: "file opens for reading" }]);
  assert.equal(res.validation_record, `.tasteful/validations/D001-art.bin-${res.actual.slice(0, 8)}.json`);
  const record = JSON.parse(await fs.readFile(path.join(p.root, res.validation_record!), "utf8")) as {
    schema_version: number;
    decision_id: string;
    artifact_path: string;
    sha256: string;
    validator_version: number;
    results: Array<{ name: string; verdict: string }>;
    validated_at: string;
    artifact_mtime_ms: number;
  };
  assert.equal(record.schema_version, 1);
  assert.equal(record.decision_id, "D001");
  assert.equal(record.artifact_path, "art.bin");
  assert.equal(record.sha256, res.actual);
  assert.equal(record.validator_version, 1);
  assert.deepEqual(record.results.map((r) => [r.name, r.verdict]), [["opens", "pass"]]);
  assert.ok(Date.parse(record.validated_at) >= record.artifact_mtime_ms);
  const owner = await readDecision(p, "D001");
  assert.equal(owner.status, "accepted");
  assert.equal(owner.review_state, "current");
  assert.equal(owner.artifacts[0].ready, true);
  assert.deepEqual(owner.artifacts[0].checks, ["opens"]);
});
