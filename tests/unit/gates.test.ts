import { rejectsWithCode, throwsWithCode } from "../assert-code.js";
/** Gate validation: evidence, self-approval, waivers; human-only pass path. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { assertGatePassable, gatePasses } from "../../src/design/gates.js";
import { computeAuthoredContentHash, computeGateContentHash, sha256Hex } from "../../src/design/hashes.js";
import { gateFile, initProject, readDecision, readGate, withLock } from "../../src/design/store.js";
import { validateGate, type Decision, type Gate } from "../../src/design/schema.js";
import { appendJournal, readJournalEntries } from "../../src/host/journal.js";
import { cmdGateAccept, cmdGateCreate, cmdStatus, makeCtx } from "../../src/cli/commands.js";
import { decisionUpsert, gateGet, gateUpsert, grantAcceptApproval, grantGateApproval } from "../../src/host/tools.js";
import { decisionBase, installApprovedGate, seedPassingValidationRecord, tempDir, writeJson } from "../helpers.js";

function gateBase(overrides?: Partial<Gate>): Gate {
  return {
    gate_id: "G-DESIGN-REVIEW",
    stage: "visual-system",
    checklist: [
      { criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: "2026-11-11" },
    ],
    decision: "pass",
    approver: "lead@example",
    owner: "designer@example",
    waivers: [],
    ...overrides,
  };
}

test("valid gate passes", () => {
  assertGatePassable(gateBase());
  assert.equal(gatePasses(gateBase()), true);
});

test("self-approval is rejected", () => {
  throwsWithCode(() => assertGatePassable(gateBase({ approver: "designer@example" })), "E_SELF_APPROVAL");
});

test("missing evidence blocks", () => {
  const g = gateBase();
  g.checklist[0] = { ...g.checklist[0], evidence_ref: "" };
  // empty evidence_ref fails schema first; construct via unknown to reach gate logic
  const raw = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
  assert.throws(() => validateGate(raw), /non-empty string/);
});

test("failed checklist item blocks", () => {
  const g = gateBase();
  g.checklist = [{ ...g.checklist[0], verdict: "fail" }];
  throwsWithCode(() => assertGatePassable(g), "E_GATE_BLOCKED");
});

test("waived without waiver blocks; with waiver passes", () => {
  const g = gateBase();
  g.checklist = [{ ...g.checklist[0], verdict: "waived" }];
  throwsWithCode(() => assertGatePassable(g), "E_GATE_BLOCKED");
  g.waivers = [{ criterion: "contrast AA", owner: "lead@example", expiry: "2026-12-01", rationale: "temporary" }];
  assertGatePassable(g);
});

test("waiver without expiry is schema-rejected", () => {
  const raw = { ...gateBase(), waivers: [{ criterion: "c", owner: "o", rationale: "r" }] };
  assert.throws(() => validateGate(raw), /expiry/);
});

test("non-pass decision blocks", () => {
  assert.equal(gatePasses(gateBase({ decision: "pending" })), false);
});

async function missing(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return false;
  } catch {
    return true;
  }
}

test("model gate_upsert cannot pass; pending/fail allowed", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const agent = makeCtx(dir, "agent");
  await rejectsWithCode(gateUpsert(agent, { gate: gateBase() }), "E_GATE_HUMAN_ONLY");
  assert.ok(await missing(gateFile(p, "G-DESIGN-REVIEW")));
  await gateUpsert(agent, { gate: gateBase({ decision: "pending" }) });
  assert.equal((await readGate(p, "G-DESIGN-REVIEW")).decision, "pending");
  await gateUpsert(agent, { gate: gateBase({ decision: "fail" }) });
  assert.equal((await readGate(p, "G-DESIGN-REVIEW")).decision, "fail");
});

test("human gate create validates before write: rejected gate leaves no file", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const g = { project: dir };
  const file = path.join(dir, "gate.json");
  const target = gateFile(p, "G-DESIGN-REVIEW");

  await writeJson(file, gateBase({ approver: "designer@example" }));
  await rejectsWithCode(cmdGateCreate(g, file), "E_SELF_APPROVAL");
  assert.ok(await missing(target));

  const failing = gateBase();
  failing.checklist = [{ ...failing.checklist[0], verdict: "fail" }];
  await writeJson(file, failing);
  await rejectsWithCode(cmdGateCreate(g, file), "E_GATE_BLOCKED");
  assert.ok(await missing(target));

  const status = JSON.parse(await cmdStatus(g, true)) as { gates: unknown[] };
  assert.deepEqual(status.gates, []);

  await writeJson(file, gateBase());
  await rejectsWithCode(cmdGateCreate(g, file), "E_GATE_NO_APPROVAL");
  assert.ok(await missing(target));

  const digest = (await cmdGateAccept(g, { file }, "lead@example")).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.match(await cmdGateCreate(g, file, digest), /G-DESIGN-REVIEW/);
  assert.equal((await readGate(p, "G-DESIGN-REVIEW")).decision, "pass");
});

test("revoked gate is schema-valid but never passable", () => {
  const g = validateGate(gateBase({ decision: "revoked" }));
  assert.equal(g.decision, "revoked");
  throwsWithCode(() => assertGatePassable(g), "E_GATE_BLOCKED");
  assert.equal(gatePasses(g), false);
});

test("gate create cannot author revoked; the human revoke transition is separate", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const g = { project: dir };
  const file = path.join(dir, "revoked.json");
  await writeJson(file, gateBase({ decision: "revoked" }));
  await rejectsWithCode(cmdGateCreate(g, file), "E_GATE_HUMAN_ONLY");
  assert.ok(await missing(gateFile(p, "G-DESIGN-REVIEW")));

  const agent = makeCtx(dir, "agent");
  await rejectsWithCode(
    gateUpsert(agent, { gate: gateBase({ decision: "revoked" }) }),
    "E_GATE_HUMAN_ONLY",
  );
});

test("authored approval_digest is system-derived and rejected", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const g = { project: dir };
  const file = path.join(dir, "gate.json");
  await writeJson(file, { ...gateBase({ decision: "pending" }), approval_digest: "a".repeat(64) });
  await rejectsWithCode(cmdGateCreate(g, file), "E_SCHEMA");
  assert.ok(await missing(gateFile(p, "G-DESIGN-REVIEW")));
});

test("model cannot overwrite a stored human pass gate (pending or fail)", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const agent = makeCtx(dir, "agent");
  const approved = await installApprovedGate(p, gateBase());
  assert.equal(approved.decision, "pass");
  assert.match(approved.approval_digest ?? "", /^[0-9a-f]{64}$/);

  for (const decision of ["pending", "fail"] as const) {
    await rejectsWithCode(
      gateUpsert(agent, { gate: gateBase({ decision }) }),
      "E_GATE_HUMAN_ONLY",
    );
  }
  const stored = await readGate(p, "G-DESIGN-REVIEW");
  assert.equal(stored.decision, "pass");
  assert.equal(stored.approval_digest, approved.approval_digest);
});

test("gate file must declare the requested id for gate get and gate accept", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const tc = makeCtx(dir);
  await writeJson(path.join(p.gates, "G-DESIGN-REVIEW.json"), gateBase({ gate_id: "G-OTHER" }));

  await rejectsWithCode(gateGet(tc, { gate_id: "G-DESIGN-REVIEW" }), "E_SCHEMA");
  await rejectsWithCode(
    cmdGateAccept({ project: dir }, { id: "G-DESIGN-REVIEW" }, "lead@example"),
    "E_SCHEMA",
  );
});

interface AcceptFixture {
  dir: string;
  p: Awaited<ReturnType<typeof initProject>>;
  tc: ReturnType<typeof makeCtx>;
  decision: Decision;
}

async function acceptFixture(id = "D001"): Promise<AcceptFixture> {
  const dir = await tempDir("tasteful-gate-prov-");
  const p = await initProject(dir, "gate-prov", "0.1.0");
  // A real project has journal history before state exists. Preflight rejects
  // hand-written state with a missing journal, so seed a valid seq-1 entry.
  const journalCtx = makeCtx(dir).journal;
  await withLock(p, () => appendJournal(p, journalCtx, { kind: "command", actor: "human", payload: { command: "init" } }));
  await fs.writeFile(path.join(dir, "art.bin"), "artifact", "utf8");
  await fs.writeFile(path.join(dir, "evidence.md"), "evidence", "utf8");
  await seedPassingValidationRecord(p, {
    decisionId: id,
    artifactPath: "art.bin",
    sha256: sha256Hex("artifact"),
    checks: ["opens"],
  });
  const decision = decisionBase(id, {
    status: "accepted",
    owner: "designer@example",
    gate_ref: "G-DESIGN-REVIEW",
    evidence: [
      { type: "review", ref: "evidence.md", sha256: sha256Hex("evidence"), captured_at: "2026-11-11" },
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
  return { dir, p, tc: makeCtx(dir, "agent"), decision };
}

async function decisionApproval(p: AcceptFixture["p"], decision: Decision): Promise<string> {
  const rec = await grantAcceptApproval(p, {
    decision_id: decision.id,
    owner: decision.owner,
    approver: "lead@example",
    contentHash: computeAuthoredContentHash(decision),
  });
  return rec.digest;
}

test("acceptance rejects a hand-written pass gate with no approval provenance", async () => {
  const { dir, p, tc, decision } = await acceptFixture();
  await writeJson(gateFile(p, "G-DESIGN-REVIEW"), gateBase());
  const digest = await decisionApproval(p, decision);
  await rejectsWithCode(decisionUpsert(tc, { decision, approval_id: digest }), "E_GATE_BLOCKED");
  await assert.rejects(fs.stat(path.join(p.decisions, "D001.json")));
});

test("acceptance rejects unresolvable and content-mismatched gate provenance", async () => {
  const { dir, p, tc, decision } = await acceptFixture();
  await writeJson(gateFile(p, "G-DESIGN-REVIEW"), {
    ...gateBase(),
    approval_digest: "b".repeat(64),
  });
  const unresolved = await decisionApproval(p, decision);
  await rejectsWithCode(decisionUpsert(tc, { decision, approval_id: unresolved }), "E_GATE_BLOCKED");

  // Real approval flow stamps provenance...
  const file = path.join(dir, "gate.json");
  await writeJson(file, gateBase());
  const g = { project: dir };
  const aid = (await cmdGateAccept(g, { file }, "lead@example")).trim();
  await cmdGateCreate(g, file, aid);
  const stored = await readGate(p, "G-DESIGN-REVIEW");
  assert.match(stored.approval_digest ?? "", /^[0-9a-f]{64}$/);

  // ...but editing the stored gate afterwards breaks the bound content.
  await writeJson(gateFile(p, "G-DESIGN-REVIEW"), {
    ...stored,
    checklist: [{ ...stored.checklist[0], criterion: "contrast AAA" }],
  });
  const mismatched = await decisionApproval(p, decision);
  await rejectsWithCode(decisionUpsert(tc, { decision, approval_id: mismatched }), "E_GATE_BLOCKED");
});

test("acceptance succeeds through the real gate_accept + gate create --approval flow", async () => {
  const { dir, p, tc, decision } = await acceptFixture();
  const file = path.join(dir, "gate.json");
  await writeJson(file, gateBase());
  const g = { project: dir };
  const aid = (await cmdGateAccept(g, { file }, "lead@example")).trim();
  await cmdGateCreate(g, file, aid);

  const digest = await decisionApproval(p, decision);
  await decisionUpsert(tc, { decision, approval_id: digest });
  const stored = await gateGet(makeCtx(dir), { gate_id: "G-DESIGN-REVIEW" });
  assert.equal(stored.decision, "pass");
  assert.match(stored.approval_digest ?? "", /^[0-9a-f]{64}$/);
  const accepted = JSON.parse(await cmdStatus(g, true)) as {
    decisions: Array<{ id: string; status: string; review_state: string }>;
  };
  assert.equal(accepted.decisions.length, 1);
  assert.equal(accepted.decisions[0].id, "D001");
  assert.equal(accepted.decisions[0].status, "accepted");
  assert.equal(accepted.decisions[0].review_state, "current");
});

test("acceptance reports E_GATE_BLOCKED when the gate file declares another id", async () => {
  const { p, tc, decision } = await acceptFixture();
  await writeJson(path.join(p.gates, "G-DESIGN-REVIEW.json"), gateBase({ gate_id: "G-OTHER" }));
  const digest = await decisionApproval(p, decision);
  await rejectsWithCode(decisionUpsert(tc, { decision, approval_id: digest }), "E_GATE_BLOCKED");
});

test("acceptance rejects a gate approval record that was never consumed", async () => {
  const { p, tc, decision } = await acceptFixture();
  const gate = gateBase();
  const { digest } = await grantGateApproval(p, {
    gate_id: gate.gate_id,
    owner: gate.owner,
    approver: gate.approver,
    contentHash: computeGateContentHash(gate),
  });
  await writeJson(gateFile(p, gate.gate_id), { ...gate, approval_digest: digest });
  const decisionDigest = await decisionApproval(p, decision);
  await rejectsWithCode(decisionUpsert(tc, { decision, approval_id: decisionDigest }), "E_GATE_BLOCKED");
});

test("self-approval check uses canonical identity; local-part case is a different identity", () => {
  throwsWithCode(
    () => assertGatePassable(gateBase({ approver: " designer@example" })),
    "E_SELF_APPROVAL",
  );
  throwsWithCode(
    () => assertGatePassable(gateBase({ owner: "User@example.com", approver: "User@EXAMPLE.com" })),
    "E_SELF_APPROVAL",
  );
  throwsWithCode(
    () => assertGatePassable(gateBase({ owner: "cafe\u0301@example.com", approver: "caf\u00e9@example.com" })),
    "E_SELF_APPROVAL",
  );
  // Local-part case is significant: these are distinct identities.
  assertGatePassable(gateBase({ owner: "User@x", approver: "user@x" }));
});

test("gate create rejects authored identity whitespace before writing", async () => {
  const dir = await tempDir("tasteful-gates-");
  const p = await initProject(dir, "gates", "0.1.0");
  const g = { project: dir };
  const file = path.join(dir, "gate.json");
  const target = gateFile(p, "G-DESIGN-REVIEW");

  for (const raw of [
    { ...gateBase({ decision: "pending" }), approver: " lead@example" },
    { ...gateBase({ decision: "pending" }), owner: "designer@example " },
  ]) {
    await writeJson(file, raw);
    await rejectsWithCode(cmdGateCreate(g, file), "E_SCHEMA");
    assert.ok(await missing(target));
  }
});

test("human gate create cannot downgrade a stored pass; gate and dependents untouched", async () => {
  const { dir, p, tc, decision } = await acceptFixture();
  const approved = await installApprovedGate(p, gateBase());
  assert.equal(approved.decision, "pass");
  const digest = await decisionApproval(p, decision);
  await decisionUpsert(tc, { decision, approval_id: digest });
  assert.equal((await readDecision(p, decision.id)).status, "accepted");

  const human = makeCtx(dir);
  const file = path.join(dir, "downgrade.json");
  for (const downgraded of ["pending", "fail"] as const) {
    await rejectsWithCode(
      gateUpsert(human, { gate: gateBase({ decision: downgraded }) }),
      "E_GATE_HUMAN_ONLY",
    );
    await writeJson(file, gateBase({ decision: downgraded }));
    await rejectsWithCode(cmdGateCreate({ project: dir }, file), "E_GATE_HUMAN_ONLY");
  }
  await writeJson(file, gateBase({ decision: "revoked" }));
  await rejectsWithCode(cmdGateCreate({ project: dir }, file), "E_GATE_HUMAN_ONLY");

  const afterGate = await readGate(p, "G-DESIGN-REVIEW");
  assert.equal(afterGate.decision, "pass");
  assert.equal(afterGate.approval_digest, approved.approval_digest);
  const dependent = await readDecision(p, decision.id);
  assert.equal(dependent.status, "accepted");
  assert.equal(dependent.review_state, "current");
  assert.ok(dependent.artifacts.every((a) => a.ready === true));
});

test("human pass -> changed pass requires and restamps a fresh gate approval", async () => {
  const { dir, p } = await acceptFixture();
  const file = path.join(dir, "gate.json");
  const g = { project: dir };
  await writeJson(file, gateBase());
  const first = (await cmdGateAccept(g, { file }, "lead@example")).trim();
  await cmdGateCreate(g, file, first);
  const before = await readGate(p, "G-DESIGN-REVIEW");
  assert.equal(before.decision, "pass");

  const changed = gateBase();
  changed.checklist = [{ ...changed.checklist[0], criterion: "contrast AAA" }];
  await writeJson(file, changed);
  await rejectsWithCode(cmdGateCreate(g, file), "E_GATE_NO_APPROVAL");

  // CLI approver input is trimmed and domain-lowercased before use.
  const second = (await cmdGateAccept(g, { file }, " lead@EXAMPLE ")).trim();
  await cmdGateCreate(g, file, second);
  const after = await readGate(p, "G-DESIGN-REVIEW");
  assert.equal(after.decision, "pass");
  assert.equal(after.checklist[0].criterion, "contrast AAA");
  assert.notEqual(after.approval_digest, before.approval_digest);
  const record = JSON.parse(
    await fs.readFile(path.join(p.approvals, `${(after.approval_digest ?? "").slice(0, 32)}.json`), "utf8"),
  ) as { approver: string };
  assert.equal(record.approver, "lead@example");
  const grants = (await readJournalEntries(p)).filter(
    (e) => e.kind === "approval" && e.payload.tool === "gate_accept",
  );
  assert.equal(grants.length, 2);
  assert.ok(grants.every((e) => e.payload.approver === "lead@example"));
});

test("acceptance gate provenance compares the approver canonically", async () => {
  const { p, tc, decision } = await acceptFixture();
  const gate = gateBase({ approver: "lead@EXAMPLE" });
  const approved = await installApprovedGate(p, gate);
  assert.equal(approved.decision, "pass");
  assert.equal(approved.approver, "lead@EXAMPLE");
  const digest = await decisionApproval(p, decision);
  await decisionUpsert(tc, { decision, approval_id: digest });
  assert.equal((await readDecision(p, decision.id)).status, "accepted");
});
