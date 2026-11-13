/**
 * Artifact checks execute for real: the closed vocabulary, recorded
 * validation records, freshness at acceptance, and failed-check demotion.
 *
 * The acceptance matrix starts from a fully valid artifact (`ready: true`,
 * fresh `validated_at`, a real file whose hash matches, and a seeded passing
 * validation record) and flips exactly one dimension per variant, asserting
 * the branch-specific rejection message (not only the shared error code).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { computeAuthoredContentHash, computeGateContentHash, sha256Hex } from "../../src/design/hashes.js";
import type { Decision, DecisionArtifact, Gate } from "../../src/design/schema.js";
import { initProject, readDecision, type ProjectPaths } from "../../src/design/store.js";
import {
  artifactValidate,
  decisionUpsert,
  gateUpsert,
  grantAcceptApproval,
  grantGateApproval,
  makeToolContext,
  type ToolContext,
} from "../../src/host/tools.js";
import { parseValidationRecord, runArtifactChecks, SUPPORTED_ARTIFACT_CHECKS } from "../../src/artcraft/validate.js";
import { generateTinyFixture } from "../fixtures/generate.js";
import { decisionBase, seedPassingValidationRecord, tempDir } from "../helpers.js";
import { codeOf, rejectsWithCode } from "../assert-code.js";

const OWNER = "designer@example";
const LEAD = "lead@example";
const GATE_ID = "G-DESIGN-REVIEW";

function ctxFor(root: string) {
  return makeToolContext(root, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "human");
}

async function setup(content = "artifact-v1"): Promise<{
  dir: string;
  project: ProjectPaths;
  artifactSha: string;
  evidenceSha: string;
}> {
  const dir = await tempDir("tasteful-checks-");
  const project = await initProject(dir, "checks", "0.1.0");
  await fs.writeFile(path.join(dir, "art.bin"), content, "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), "review evidence", "utf8");
  return {
    dir,
    project,
    artifactSha: sha256Hex(content),
    evidenceSha: sha256Hex("review evidence"),
  };
}

/** A fully valid artifact: the matrix flips one dimension per variant. */
function artifact(sha: string, overrides?: Partial<DecisionArtifact>): DecisionArtifact {
  return {
    path: "art.bin",
    sha256: sha,
    validator_version: 1,
    validated_at: new Date().toISOString(),
    checks: ["opens"],
    ready: true,
    ...overrides,
  };
}

function evidenceFor(sha: string) {
  return [{ type: "review", ref: "evidence.md", sha256: sha, captured_at: "2026-11-11" }];
}

function proposed(id: string, sha: string, overrides?: Partial<Decision>): Decision {
  return decisionBase(id, {
    owner: OWNER,
    artifacts: [artifact(sha)],
    ...overrides,
  });
}

async function writePassingGate(tc: ToolContext): Promise<Gate> {
  const gate: Gate = {
    gate_id: GATE_ID,
    stage: "visual-system",
    checklist: [
      { criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: "2026-11-11" },
    ],
    decision: "pass",
    approver: LEAD,
    owner: OWNER,
    waivers: [],
  };
  const grant = await grantGateApproval(tc.project, {
    gate_id: gate.gate_id,
    owner: gate.owner,
    approver: gate.approver,
    contentHash: computeGateContentHash(gate),
  });
  await gateUpsert(tc, { gate, approval_id: grant.digest });
  return gate;
}

function readRecord(dir: string, rel: string) {
  return fs.readFile(path.join(dir, rel), "utf8").then((text) => parseValidationRecord(JSON.parse(text)));
}

/** Await a rejection, assert its code, and return its message for matching. */
async function rejectionMessage(p: Promise<unknown>, expectedCode: string): Promise<string> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err !== undefined, `expected rejection with ${expectedCode}, but it resolved`);
  assert.equal(codeOf(err), expectedCode);
  return err instanceof Error ? err.message : String(err);
}

interface MatrixContext {
  dir: string;
  project: ProjectPaths;
  tc: ToolContext;
  artifactSha: string;
  evidenceSha: string;
}

async function matrixContext(): Promise<MatrixContext> {
  const { dir, project, artifactSha, evidenceSha } = await setup();
  return { dir, project, tc: ctxFor(dir), artifactSha, evidenceSha };
}

/** The accepted shape around the one artifact dimension under test. */
function acceptedDecision(
  artifactSha: string,
  evidenceSha: string,
  overrides?: Partial<DecisionArtifact>,
): Decision {
  return decisionBase("D001", {
    status: "accepted",
    owner: OWNER,
    gate_ref: GATE_ID,
    evidence: evidenceFor(evidenceSha),
    artifacts: [artifact(artifactSha, overrides)],
  });
}

/**
 * Reject an accepted submission that differs from the valid baseline in one
 * artifact dimension. Defaults: seeded passing record and an untouched file.
 */
async function expectArtifactRejection(
  label: string,
  overrides: Partial<DecisionArtifact>,
  expected: RegExp,
  opts: { seed?: boolean } = {},
): Promise<void> {
  const env = await matrixContext();
  if (opts.seed !== false) {
    await seedPassingValidationRecord(env.project, {
      decisionId: "D001",
      artifactPath: "art.bin",
      sha256: env.artifactSha,
      checks: ["opens"],
    });
  }
  const message = await rejectionMessage(
    decisionUpsert(env.tc, { decision: acceptedDecision(env.artifactSha, env.evidenceSha, overrides) }),
    "E_ACCEPT_NO_ARTIFACT",
  );
  assert.match(message, expected, `${label}: unexpected rejection message`);
  const stored = await readDecision(env.project, "D001").catch(() => undefined);
  assert.equal(stored, undefined, `${label}: rejected acceptance must not persist a decision`);
}

test("artifact checks: unknown and inapplicable names fail; opens passes a plain file", async () => {
  const dir = await tempDir("tasteful-checks-vocab-");
  const exportsDir = path.join(dir, "exports");
  await fs.mkdir(exportsDir);
  const file = path.join(dir, "art.bin");
  await fs.writeFile(file, "artifact-v1", "utf8");
  const results = await runArtifactChecks(
    file,
    ["opens", "exports", "tokens-resolve", "fail", "opens:failed"],
    { projectRoot: dir, exportsDir },
  );
  assert.deepEqual(results.map((r) => r.name), ["opens", "exports", "tokens-resolve", "fail", "opens:failed"]);
  assert.equal(results[0].verdict, "pass");
  for (const r of results.slice(1)) assert.equal(r.verdict, "fail", `${r.name} must fail`);
  assert.match(results[1].detail, /only applies to \.figcraft/);
  assert.match(results[2].detail, /only applies to \.figcraft/);
  assert.match(results[3].detail, /unknown check/);
  assert.match(results[4].detail, /unknown check/);
});

test("artifact checks: a real .figcraft fixture passes opens/exports/tokens-resolve and cleans temp output", async () => {
  const dir = await tempDir("tasteful-checks-figcraft-");
  const { file } = await generateTinyFixture(path.join(dir, "gen"));
  const exportsDir = path.join(dir, "exports");
  await fs.mkdir(exportsDir);
  const results = await runArtifactChecks(file, [...SUPPORTED_ARTIFACT_CHECKS], { projectRoot: dir, exportsDir });
  assert.deepEqual(results.map((r) => r.verdict), ["pass", "pass", "pass"]);
  assert.deepEqual(await fs.readdir(exportsDir), [], "temp export must be deleted");
});

test("artifact_validate runs recorded checks, writes a record, and demotes on failure", async () => {
  const { dir, project, artifactSha } = await setup();
  const tc = ctxFor(dir);
  await decisionUpsert(tc, { decision: proposed("D001", artifactSha, { artifacts: [artifact(artifactSha, { checks: ["exports"] })] }) });

  const res = await artifactValidate(tc, { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(res.ok, false);
  assert.equal(res.drifted, undefined);
  assert.equal(res.expected, artifactSha);
  assert.equal(res.actual, artifactSha);
  assert.deepEqual(res.results, [{ name: "exports", verdict: "fail", detail: "exports only applies to .figcraft artifacts" }]);
  assert.match(res.validation_record ?? "", /^\.tasteful\/validations\/D001-art\.bin-[0-9a-f]{8}\.json$/);
  const record = await readRecord(dir, res.validation_record!);
  assert.ok(record);
  assert.equal(record.schema_version, 1);
  assert.equal(record.decision_id, "D001");
  assert.equal(record.artifact_path, "art.bin");
  assert.equal(record.sha256, artifactSha);
  assert.equal(record.validator_version, 1);
  assert.equal(record.results[0].verdict, "fail");
  assert.equal(record.artifact_mtime_ms, Math.floor((await fs.stat(path.join(dir, "art.bin"))).mtimeMs));

  const stored = await readDecision(project, "D001");
  assert.equal(stored.review_state, "needs_review");
  assert.equal(stored.artifacts[0].ready, false);
  assert.deepEqual(stored.artifacts[0].checks, ["exports"]);
});

// ---------------------------------------------------------------------------
// Acceptance rejection matrix: one dimension per test, branch message asserted.
// ---------------------------------------------------------------------------

test("acceptance matrix: failed check label 'fail' is rejected as unsupported", async () => {
  await expectArtifactRejection("failed label", { checks: ["fail"] }, /unsupported check 'fail'/);
});

test("acceptance matrix: prefixed label 'opens:failed' is rejected as unsupported", async () => {
  await expectArtifactRejection("prefixed label", { checks: ["opens:failed"] }, /unsupported check 'opens:failed'/);
});

test("acceptance matrix: empty checks is rejected for lacking validation checks", async () => {
  await expectArtifactRejection("empty checks", { checks: [] }, /lacks validation checks/);
});

test("acceptance matrix: stale validated_at is rejected as stale with a validate hint", async () => {
  await expectArtifactRejection(
    "stale validated_at",
    { validated_at: "2000-01-01T00:00:00.000Z" },
    /validation is stale \(validated_at 2000-01-01T00:00:00\.000Z, file mtime .*\); run artifact_validate again/,
  );
});

test("acceptance matrix: missing passing validation record is rejected by record name", async () => {
  await expectArtifactRejection(
    "no validation record",
    {},
    /has no passing validation record for sha256 [0-9a-f]{64} and checks \[opens\]; run artifact_validate first/,
    { seed: false },
  );
});

test("acceptance matrix: unsupported validator_version 2 is rejected by version", async () => {
  await expectArtifactRejection(
    "validator version",
    { validator_version: 2 },
    /validator_version 2 unsupported \(expected 1\)/,
  );
});

test("acceptance matrix: mtime-only touch after validation is stale even with unchanged bytes/hash", async () => {
  const env = await matrixContext();
  await seedPassingValidationRecord(env.project, {
    decisionId: "D001",
    artifactPath: "art.bin",
    sha256: env.artifactSha,
    checks: ["opens"],
  });
  const file = path.join(env.dir, "art.bin");
  const bytesBefore = await fs.readFile(file);
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await fs.utimes(file, future, future);
  const bytesAfter = await fs.readFile(file);
  assert.deepEqual(bytesAfter, bytesBefore, "the touch must not change artifact bytes");
  assert.equal(sha256Hex(bytesAfter), env.artifactSha, "the touch must not change the hash");

  const message = await rejectionMessage(
    decisionUpsert(env.tc, { decision: acceptedDecision(env.artifactSha, env.evidenceSha) }),
    "E_ACCEPT_NO_ARTIFACT",
  );
  assert.match(message, /validation is stale .*run artifact_validate again/);
});

test("acceptance matrix: a real fresh validate is stale once the artifact mtime moves later", async () => {
  const { dir, project, artifactSha, evidenceSha } = await setup();
  const tc = ctxFor(dir);
  await decisionUpsert(tc, { decision: proposed("D001", artifactSha) });
  const validation = await artifactValidate(tc, { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(validation.ok, true);
  const stored = await readDecision(project, "D001");
  assert.equal(stored.artifacts[0].ready, true);

  // Same bytes/hash, but the mtime now outruns the validated_at that the
  // real artifact_validate just recorded.
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await fs.utimes(path.join(dir, "art.bin"), future, future);
  const accepted = {
    ...stored,
    status: "accepted",
    gate_ref: GATE_ID,
    evidence: evidenceFor(evidenceSha),
  } as Decision;
  delete accepted.review_state;
  delete accepted.decision_hash;

  const message = await rejectionMessage(decisionUpsert(tc, { decision: accepted }), "E_ACCEPT_NO_ARTIFACT");
  assert.match(message, /validation is stale .*run artifact_validate again/);
  const after = await readDecision(project, "D001");
  assert.equal(after.status, "proposed", "rejected acceptance must leave the stored state unchanged");
});

test("acceptance matrix: ready:false is rejected before any file work", async () => {
  await expectArtifactRejection("ready false", { ready: false }, /artifact 'art\.bin' not ready/);
});

test("acceptance matrix: fresh validate -> accept -> create succeeds; artifact touched after validation is stale", async () => {
  const { dir, project, artifactSha, evidenceSha } = await setup();
  const tc = ctxFor(dir);
  await decisionUpsert(tc, { decision: proposed("D001", artifactSha) });
  const validation = await artifactValidate(tc, { decision_id: "D001", artifact_path: "art.bin" });
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.results, [{ name: "opens", verdict: "pass", detail: "file opens for reading" }]);

  const record = await readRecord(dir, validation.validation_record!);
  assert.ok(record);
  assert.equal(record.sha256, artifactSha);
  assert.equal(record.validator_version, 1);
  assert.deepEqual(record.results.map((r) => [r.name, r.verdict]), [["opens", "pass"]]);
  assert.ok(Date.parse(record.validated_at) >= record.artifact_mtime_ms);

  await writePassingGate(tc);
  const stored = await readDecision(project, "D001");
  const authored = { ...stored } as Partial<Decision>;
  delete authored.review_state;
  delete authored.decision_hash;
  const accepted: Decision = {
    ...(authored as Decision),
    status: "accepted",
    gate_ref: GATE_ID,
    evidence: evidenceFor(evidenceSha),
  };
  const approval = await grantAcceptApproval(project, {
    decision_id: "D001",
    owner: OWNER,
    approver: LEAD,
    contentHash: computeAuthoredContentHash(accepted),
  });
  await decisionUpsert(tc, { decision: accepted, approval_id: approval.digest });
  const acceptedStored = await readDecision(project, "D001");
  assert.equal(acceptedStored.status, "accepted");
  assert.equal(acceptedStored.review_state, "current");
  assert.equal(acceptedStored.artifacts[0].ready, true);

  // D002: validate, then touch the artifact so its mtime outruns the recorded
  // validation. The recorded (new) hash matches, so only freshness can reject.
  const { dir: dir2, project: p2, artifactSha: sha2, evidenceSha: ev2 } = await setup("second-artifact");
  const tc2 = ctxFor(dir2);
  await decisionUpsert(tc2, { decision: proposed("D002", sha2) });
  const v2 = await artifactValidate(tc2, { decision_id: "D002", artifact_path: "art.bin" });
  assert.equal(v2.ok, true);
  const stored2 = await readDecision(p2, "D002");
  await fs.appendFile(path.join(dir2, "art.bin"), "!", "utf8");
  const changedSha = sha256Hex("second-artifact!");
  const future = new Date(Date.now() + 5000);
  await fs.utimes(path.join(dir2, "art.bin"), future, future);
  const touched: Decision = {
    ...stored2,
    status: "accepted",
    gate_ref: GATE_ID,
    evidence: evidenceFor(ev2),
    artifacts: [{ ...stored2.artifacts[0], sha256: changedSha }],
  };
  delete touched.review_state;
  delete touched.decision_hash;
  await rejectsWithCode(decisionUpsert(tc2, { decision: touched }), "E_ACCEPT_NO_ARTIFACT");
  const after = await readDecision(p2, "D002");
  assert.equal(after.status, "proposed", "rejected acceptance must leave the stored state unchanged");
});
