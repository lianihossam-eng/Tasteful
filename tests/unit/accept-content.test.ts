import { rejectsWithCode } from "../assert-code.js";
/** Human acceptance/gate approvals bind exact content; accepted artifacts are real. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { computeAuthoredContentHash, computeGateContentHash, sha256Hex } from "../../src/design/hashes.js";
import type { Decision, DecisionArtifact, Gate } from "../../src/design/schema.js";
import { initProject, readGate } from "../../src/design/store.js";
import { readJournalEntries } from "../../src/host/journal.js";
import {
  checkAcceptApproval,
  decisionUpsert,
  gateUpsert,
  grantAcceptApproval,
  grantGateApproval,
  makeToolContext,
} from "../../src/host/tools.js";
import { decisionBase, installApprovedGate, seedPassingValidationRecord, tempDir, writeJson } from "../helpers.js";
import { CliError, cmdAccept, cmdDecisionCreate } from "../../src/cli/commands.js";

const OWNER = "designer@example";
const APPROVER = "lead@example";
const GATE_ID = "G-DESIGN-REVIEW";
const DAY = "2026-11-11";
const ARTIFACT_A = "artifact-a";
const ARTIFACT_B = "artifact-b";
const EVIDENCE = "review evidence";

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

function artifact(pathName: string, sha: string, overrides?: Partial<DecisionArtifact>): DecisionArtifact {
  return {
    path: pathName,
    sha256: sha,
    validator_version: 1,
    validated_at: new Date().toISOString(),
    checks: ["opens"],
    ready: true,
    ...overrides,
  };
}

async function setup(prefix = "tasteful-accept-") {
  const dir = await tempDir(prefix);
  const p = await initProject(dir, "accept", "0.1.0");
  await fs.writeFile(path.join(dir, "art-a.bin"), ARTIFACT_A, "utf8");
  await fs.writeFile(path.join(dir, "art-b.bin"), ARTIFACT_B, "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), EVIDENCE, "utf8");
  await installApprovedGate(p, PASS_GATE);
  const artifactSha = sha256Hex(ARTIFACT_A);
  const secondArtifactSha = sha256Hex(ARTIFACT_B);
  for (const checks of [["opens"], ["opens", "exports"]]) {
    await seedPassingValidationRecord(p, {
      decisionId: "D001",
      artifactPath: "art-a.bin",
      sha256: artifactSha,
      checks,
    });
  }
  await seedPassingValidationRecord(p, {
    decisionId: "D001",
    artifactPath: "art-a.bin",
    sha256: secondArtifactSha,
    checks: ["opens"],
  });
  await seedPassingValidationRecord(p, {
    decisionId: "D001",
    artifactPath: "art-b.bin",
    sha256: secondArtifactSha,
    checks: ["opens"],
  });
  await seedPassingValidationRecord(p, {
    decisionId: "D010",
    artifactPath: "art-a.bin",
    sha256: artifactSha,
    checks: ["opens"],
  });
  const journal = { tastefulVersion: "0.1.0", piVersion: "1.5.2" };
  return {
    dir,
    p,
    tc: makeToolContext(dir, journal, "agent"),
    human: makeToolContext(dir, journal, "human"),
    artifactSha,
    secondArtifactSha,
    evidenceSha: sha256Hex(EVIDENCE),
  };
}

interface Hashes {
  artifactSha: string;
  secondArtifactSha: string;
  evidenceSha: string;
}

function accepted(id: string, h: Hashes): Decision {
  return decisionBase(id, {
    status: "accepted",
    owner: OWNER,
    gate_ref: GATE_ID,
    evidence: [{ type: "review", ref: "evidence.md", sha256: h.evidenceSha, captured_at: DAY }],
    artifacts: [artifact("art-a.bin", h.artifactSha)],
  });
}

function clone(d: Decision): Decision {
  return JSON.parse(JSON.stringify(d)) as Decision;
}

test("exact accepted content is accepted; every authored mutation is E_APPROVAL_MISMATCH", async () => {
  const { p, tc, artifactSha, secondArtifactSha, evidenceSha } = await setup();
  const base = accepted("D001", { artifactSha, secondArtifactSha, evidenceSha });

  // Exact content: bound approval accepted and consumed.
  const exact = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(base),
  });
  const stored = await decisionUpsert(tc, { decision: base, approval_id: exact.digest });
  assert.equal(stored.id, "D001");

  // Matrix approval stays unused across mismatches (mismatch never consumes).
  const matrix = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(base),
  });

  const mutations: Array<[string, (d: Decision) => void]> = [
    ["title", (d) => { d.title = "MUTATED TITLE"; }],
    ["claims", (d) => { d.claims = [{ claim_id: "C-X", subject: "s", predicate: "p", value: "v", scope: "project" }]; }],
    ["evidence", (d) => { d.evidence[0] = { ...d.evidence[0], captured_at: "2026-12-01" }; }],
    ["artifact-path", (d) => { d.artifacts[0] = { ...d.artifacts[0], path: "art-b.bin" }; }],
    ["artifact-hash", (d) => { d.artifacts[0] = { ...d.artifacts[0], sha256: secondArtifactSha }; }],
    ["checks", (d) => { d.artifacts[0] = { ...d.artifacts[0], checks: ["opens", "exports"] }; }],
    ["version", (d) => { d.version = 2; }],
    ["gate_ref", (d) => { d.gate_ref = "G-OTHER"; }],
    ["owner", (d) => { d.owner = "other@example"; }],
    ["status", (d) => { d.status = "proposed"; }],
  ];
  for (const [label, mutate] of mutations) {
    const mutated = clone(base);
    mutate(mutated);
    await rejectsWithCode(
      checkAcceptApproval(p, matrix.digest, OWNER, "D001", computeAuthoredContentHash(mutated)),
      "E_APPROVAL_MISMATCH",
    );
    assert.equal(
      (await fs.readFile(path.join(p.approvals, `${matrix.digest.slice(0, 32)}.json`), "utf8")).includes('"used":false'),
      true,
      `${label}: mismatch must not consume the approval`,
    );
  }
});

test("full upsert: title, artifact-path, gate_ref, and status mutations are E_APPROVAL_MISMATCH", async () => {
  const { p, tc, artifactSha, secondArtifactSha, evidenceSha } = await setup();
  const base = accepted("D001", { artifactSha, secondArtifactSha, evidenceSha });
  const { digest } = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(base),
  });

  await rejectsWithCode(
    decisionUpsert(tc, { decision: { ...clone(base), title: "changed" }, approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );
  await rejectsWithCode(
    decisionUpsert(tc, {
      decision: {
        ...clone(base),
        artifacts: [artifact("art-b.bin", secondArtifactSha)],
      },
      approval_id: digest,
    }),
    "E_APPROVAL_MISMATCH",
  );
  await rejectsWithCode(
    decisionUpsert(tc, { decision: { ...clone(base), status: "proposed" }, approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );

  await installApprovedGate(p, {
    ...PASS_GATE,
    gate_id: "G-OTHER",
    checklist: [{ ...PASS_GATE.checklist[0], criterion: "motion reduced" }],
  });
  await rejectsWithCode(
    decisionUpsert(tc, { decision: { ...clone(base), gate_ref: "G-OTHER" }, approval_id: digest }),
    "E_APPROVAL_MISMATCH",
  );
});

test("accepted rejects missing/fabricated/unsupported artifacts", async () => {
  const { p, tc, artifactSha, secondArtifactSha, evidenceSha } = await setup();
  const hashes = { artifactSha, secondArtifactSha, evidenceSha };
  const variants: Array<[string, Decision]> = [
    ["missing file", { ...accepted("D001", hashes), artifacts: [artifact("missing.png", "b".repeat(64))] }],
    ["wrong hash", { ...accepted("D001", hashes), artifacts: [artifact("art-a.bin", "b".repeat(64))] }],
    ["ready false", { ...accepted("D001", hashes), artifacts: [artifact("art-a.bin", artifactSha, { ready: false })] }],
    ["no validated_at", { ...accepted("D001", hashes), artifacts: [artifact("art-a.bin", artifactSha, { validated_at: undefined })] }],
    ["empty checks", { ...accepted("D001", hashes), artifacts: [artifact("art-a.bin", artifactSha, { checks: [] })] }],
    ["unsupported validator", { ...accepted("D001", hashes), artifacts: [artifact("art-a.bin", artifactSha, { validator_version: 2 })] }],
    ["no artifacts", { ...accepted("D001", hashes), artifacts: [] }],
  ];
  for (const [label, decision] of variants) {
    const { digest } = await grantAcceptApproval(p, {
      decision_id: "D001",
      owner: OWNER,
      approver: APPROVER,
      contentHash: computeAuthoredContentHash(decision),
    });
    await rejectsWithCode(
      decisionUpsert(tc, { decision, approval_id: digest }),
      "E_ACCEPT_NO_ARTIFACT",
    );
    assert.equal(
      (await fs.readFile(path.join(p.approvals, `${digest.slice(0, 32)}.json`), "utf8")).includes('"used":false'),
      true,
      `${label}: rejection must not consume the approval`,
    );
  }
});

test("accepted rejects missing/mismatched project evidence; external ref allowed with journal warning", async () => {
  const { p, tc, artifactSha, secondArtifactSha, evidenceSha } = await setup();
  const hashes = { artifactSha, secondArtifactSha, evidenceSha };

  const missingEvidence: Decision = {
    ...accepted("D001", hashes),
    evidence: [{ type: "review", ref: "missing-evidence.md", sha256: "c".repeat(64) }],
  };
  const missingApproval = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(missingEvidence),
  });
  await rejectsWithCode(
    decisionUpsert(tc, { decision: missingEvidence, approval_id: missingApproval.digest }),
    "E_ACCEPT_NO_EVIDENCE",
  );

  const wrongHash: Decision = {
    ...accepted("D001", hashes),
    evidence: [{ type: "review", ref: "evidence.md", sha256: "c".repeat(64) }],
  };
  const wrongApproval = await grantAcceptApproval(p, {
    decision_id: "D001",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(wrongHash),
  });
  await rejectsWithCode(
    decisionUpsert(tc, { decision: wrongHash, approval_id: wrongApproval.digest }),
    "E_ACCEPT_NO_EVIDENCE",
  );

  const external: Decision = {
    ...accepted("D010", hashes),
    evidence: [{ type: "external", ref: "https://example.invalid/report.json", sha256: "d".repeat(64) }],
  };
  const externalApproval = await grantAcceptApproval(p, {
    decision_id: "D010",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeAuthoredContentHash(external),
  });
  await decisionUpsert(tc, { decision: external, approval_id: externalApproval.digest });
  const warnings = (await readJournalEntries(p)).filter(
    (e) => e.payload.warning === "evidence ref not file-verified (external)",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].payload.ref, "https://example.invalid/report.json");
});

test("CLI create maps mutated approved content to E_APPROVAL_MISMATCH with exit 3", async () => {
  const { dir, artifactSha, secondArtifactSha, evidenceSha } = await setup();
  const base = accepted("D001", { artifactSha, secondArtifactSha, evidenceSha });
  const file = path.join(dir, "D001.json");
  await writeJson(file, base);
  const digest = (await cmdAccept({ project: dir }, { file }, APPROVER)).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);

  await writeJson(file, { ...clone(base), title: "mutated after approval" });
  let err: unknown;
  try {
    await cmdDecisionCreate({ project: dir }, file, digest);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof CliError, "expected CliError");
  assert.equal((err as CliError).code, "E_APPROVAL_MISMATCH");
  assert.equal((err as CliError).exitCode, 3);
});

test("gate pass requires an approval bound to the exact gate content", async () => {
  const { p, human } = await setup();
  const gate: Gate = { ...PASS_GATE, gate_id: "G-GATE-BIND" };

  await rejectsWithCode(gateUpsert(human, { gate }), "E_GATE_NO_APPROVAL");
  await assert.rejects(fs.stat(path.join(p.gates, "G-GATE-BIND.json")));

  const { digest } = await grantGateApproval(p, {
    gate_id: "G-GATE-BIND",
    owner: OWNER,
    approver: APPROVER,
    contentHash: computeGateContentHash(gate),
  });
  const mutated: Gate = { ...gate, stage: "visual-system-revised" };
  await rejectsWithCode(gateUpsert(human, { gate: mutated, approval_id: digest }), "E_APPROVAL_MISMATCH");
  await assert.rejects(fs.stat(path.join(p.gates, "G-GATE-BIND.json")));

  await gateUpsert(human, { gate, approval_id: digest });
  assert.equal((await readGate(p, "G-GATE-BIND")).stage, gate.stage);
  await rejectsWithCode(gateUpsert(human, { gate, approval_id: digest }), "E_APPROVAL_REPLAY");
});

test("gate self-approval is rejected at grant time", async () => {
  const { p } = await setup();
  await rejectsWithCode(
    grantGateApproval(p, {
      gate_id: "G-GATE-BIND",
      owner: OWNER,
      approver: OWNER,
      contentHash: computeGateContentHash({ ...PASS_GATE, gate_id: "G-GATE-BIND" }),
    }),
    "E_SELF_APPROVAL",
  );
});
