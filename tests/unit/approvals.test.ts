import { rejectsWithCode } from "../assert-code.js";
/** Approvals: deny-by-default, single-use, replay/mutation rejection, acceptance binding. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { canonicalJson, computeAuthoredContentHash, sha256Hex } from "../../src/design/hashes.js";
import { initProject } from "../../src/design/store.js";
import {
  consumeApproval,
  contentHash,
  denyApproval,
  grantApproval,
  operationDigest,
  paramsHash,
} from "../../src/host/approvals.js";
import {
  decisionGet,
  decisionUpsert,
  grantAcceptApproval,
  makeToolContext,
} from "../../src/host/tools.js";
import { decisionBase, installApprovedGate, seedPassingValidationRecord, tempDir, writeJson } from "../helpers.js";

const OP = { tool: "fs_write", target: "/t/f.txt", content: "hello", params: { path: "f.txt" } };
const OWNER = "designer@example";
const APPROVER = "lead@example";
const GATE_ID = "G-DESIGN-REVIEW";
const ARTIFACT_BYTES = "artifact-bytes";
const EVIDENCE_BYTES = "review evidence";

function acceptedDecision(
  id: string,
  artifactSha: string,
  evidenceSha: string,
  owner = OWNER,
): Record<string, unknown> {
  return decisionBase(id, {
    status: "accepted",
    owner,
    gate_ref: GATE_ID,
    evidence: [{ type: "review", ref: "evidence.md", sha256: evidenceSha, captured_at: "2026-11-11" }],
    artifacts: [
      {
        path: "art.bin",
        sha256: artifactSha,
        validator_version: 1,
        validated_at: new Date().toISOString(),
        checks: ["opens"],
        ready: true,
      },
    ],
  }) as unknown as Record<string, unknown>;
}

async function seed(prefix = "tasteful-appr-") {
  const dir = await tempDir(prefix);
  const p = await initProject(dir, "a", "0.1.0");
  await fs.writeFile(path.join(dir, "art.bin"), ARTIFACT_BYTES, "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), EVIDENCE_BYTES, "utf8");
  const artifactSha = sha256Hex(ARTIFACT_BYTES);
  const evidenceSha = sha256Hex(EVIDENCE_BYTES);
  await installApprovedGate(p, {
    gate_id: GATE_ID,
    stage: "visual-system",
    checklist: [
      { criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: "2026-11-11" },
    ],
    decision: "pass",
    approver: APPROVER,
    owner: OWNER,
    waivers: [],
  });
  for (const decisionId of ["D001", "D002"]) {
    await seedPassingValidationRecord(p, {
      decisionId,
      artifactPath: "art.bin",
      sha256: artifactSha,
      checks: ["opens"],
    });
  }
  const tc = makeToolContext(dir, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "agent");
  return { dir, p, tc, artifactSha, evidenceSha };
}

function approvalPath(p: { approvals: string }, digest: string): string {
  return path.join(p.approvals, `${digest.slice(0, 32)}.json`);
}

test("deny by default: no record -> E_APPROVAL_DENIED", async () => {
  const dir = await tempDir("tasteful-appr-");
  const p = await initProject(dir, "a", "0.1.0");
  await rejectsWithCode(consumeApproval(p, OP), "E_APPROVAL_DENIED");
});

test("grant -> consume ok; replay rejected", async () => {
  const dir = await tempDir("tasteful-appr-");
  const p = await initProject(dir, "a", "0.1.0");
  await grantApproval(p, { ...OP, approver: "op@tasteful" });
  await consumeApproval(p, OP);
  await rejectsWithCode(consumeApproval(p, OP), "E_APPROVAL_REPLAY");
});

test("mutated payload rejected", async () => {
  const dir = await tempDir("tasteful-appr-");
  const p = await initProject(dir, "a", "0.1.0");
  await grantApproval(p, { ...OP, approver: "op@tasteful" });
  // The digest-addressed record is not found for the mutated operation.
  await rejectsWithCode(consumeApproval(p, { ...OP, content: "mutated" }), "E_APPROVAL_DENIED");
});

test("denied record rejected", async () => {
  const dir = await tempDir("tasteful-appr-");
  const p = await initProject(dir, "a", "0.1.0");
  await denyApproval(p, { ...OP, approver: "op@tasteful" });
  await rejectsWithCode(consumeApproval(p, OP), "E_APPROVAL_DENIED");
});

test("digest is stable and content-sensitive", () => {
  const a = operationDigest(OP);
  const b = operationDigest({ ...OP });
  assert.equal(a, b);
  assert.notEqual(a, operationDigest({ ...OP, content: "other" }));
  assert.notEqual(a, operationDigest({ ...OP, tool: "other" }));
});

test("acceptance grant -> use -> replay denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D001", artifactSha, evidenceSha);
  const authoredHash = computeAuthoredContentHash(d);
  const { digest, approval_id } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: authoredHash,
  });
  assert.equal(approval_id, digest);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const raw = JSON.parse(await fs.readFile(approvalPath(p, digest), "utf8")) as Record<string, unknown>;
  assert.equal(raw.digest, digest);
  assert.equal(raw.tool, "decision_accept");
  assert.equal(raw.target, "D001");
  // Bound to the decision content, NOT to the owner string.
  assert.equal(raw.content_hash, authoredHash);
  assert.notEqual(raw.content_hash, contentHash(OWNER));
  assert.equal(raw.params_hash, paramsHash({ approver: APPROVER }));
  assert.equal(raw.used, false);
  await decisionUpsert(tc, { decision: d, approval_id: digest });
  await rejectsWithCode(decisionUpsert(tc, { decision: d, approval_id: digest }), "E_APPROVAL_REPLAY");
});

test("acceptance approval by basename works once", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D002", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D002",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(d),
  });
  await decisionUpsert(tc, { decision: d, approval_id: `${digest.slice(0, 32)}.json` });
  await rejectsWithCode(
    decisionUpsert(tc, { decision: d, approval_id: `${digest.slice(0, 32)}.json` }),
    "E_APPROVAL_REPLAY",
  );
});

test("acceptance approval transferred to another decision denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const approved = acceptedDecision("D001", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(approved),
  });
  await rejectsWithCode(
    decisionUpsert(tc, { decision: acceptedDecision("D002", artifactSha, evidenceSha), approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );
});

test("acceptance approval for wrong owner denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const approved = acceptedDecision("D001", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(approved),
  });
  await rejectsWithCode(
    decisionUpsert(tc, {
      decision: acceptedDecision("D001", artifactSha, evidenceSha, "other@example"),
      approval_id: digest,
    }),
    "E_APPROVAL_MISMATCH",
  );
});

test("acceptance approval with mutated approver denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D001", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(d),
  });
  const file = approvalPath(p, digest);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  raw.approver = "boss@example";
  await fs.writeFile(file, canonicalJson(raw) + "\n", "utf8");
  await rejectsWithCode(
    decisionUpsert(tc, { decision: d, approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );
});

test("acceptance approval with mutated record digest denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D001", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(d),
  });
  const file = approvalPath(p, digest);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  raw.digest = "c".repeat(64);
  raw.content_hash = "d".repeat(64);
  await fs.writeFile(file, canonicalJson(raw) + "\n", "utf8");
  await rejectsWithCode(
    decisionUpsert(tc, { decision: d, approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );
});

test("acceptance approval id outside approvals dir denied", async () => {
  const { p, tc, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D001", artifactSha, evidenceSha);
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(d),
  });
  const abs = approvalPath(p, digest);
  const base = path.basename(abs);
  await rejectsWithCode(
    decisionUpsert(tc, { decision: d, approval_id: abs }),
    "E_APPROVAL_PATH",
  );
  await rejectsWithCode(
    decisionUpsert(tc, { decision: d, approval_id: `../approvals/${base}` }),
    "E_APPROVAL_PATH",
  );
});

test("headless accepted decision without approval is denied", async () => {
  const { tc, artifactSha, evidenceSha } = await seed();
  await rejectsWithCode(
    decisionUpsert(tc, { decision: acceptedDecision("D001", artifactSha, evidenceSha) }),
    "E_ACCEPT_NO_APPROVAL",
  );
});

test("self-approval grant rejected", async () => {
  const { p, artifactSha, evidenceSha } = await seed();
  const d = acceptedDecision("D001", artifactSha, evidenceSha, OWNER);
  await rejectsWithCode(
    grantAcceptApproval(p, {
      decision_id: "D001",
      owner: OWNER,
      approver: OWNER,
      contentHash: computeAuthoredContentHash(d),
    }),
    "E_SELF_APPROVAL",
  );
});

test("decision_get traversal and hash tamper rejected", async () => {
  const { dir, tc } = await seed();
  await rejectsWithCode(decisionGet(tc, { id: "../../etc/passwd" }), "E_PATH");
  await rejectsWithCode(decisionGet(tc, { id: "D001/../../x" }), "E_PATH");
  await decisionUpsert(tc, { decision: decisionBase("D003") });
  const file = path.join(dir, ".tasteful", "decisions", "D003.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  stored.title = "tampered title";
  await writeJson(file, stored);
  await rejectsWithCode(decisionGet(tc, { id: "D003" }), "E_HASH_MISMATCH");
});
