/**
 * End-to-end BRIM scenario through the shipped CLI.
 *
 * Every scenario step is a separate `node dist/src/bin.js` child process
 * (init -> brief -> adapter/info/export -> decisions -> gate -> accept ->
 * invalidate -> drift -> run -> status). We assert exit codes, parse JSON
 * output, and pin the exact closure. BRIM is read-only; the test skips with
 * an explicit reason when the fixture is absent (TASTEFUL_BRIM override).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import test from "node:test";
import { hashFile } from "../../src/design/hashes.js";
import type { Decision, Gate } from "../../src/design/schema.js";
import { BRIM, brimSkipReason, decisionBase, tempDir, writeJson } from "../helpers.js";

const OWNER = "designer@example";
const LEAD = "lead@example";
const DAY = "2026-11-11";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Compiled test lives in dist/tests/e2e; the launcher in dist/src. */
const CLI = path.resolve(HERE, "../../src/bin.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(project: string, home: string, args: string[]): CliResult {
  const res = spawnSync(process.execPath, [CLI, "--project", project, ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, TASTEFUL_HOME: home },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (res.error) throw res.error;
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function ok(label: string, res: CliResult): string {
  assert.equal(res.code, 0, `${label}: exit ${res.code}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`);
  return res.stdout;
}

function fails(label: string, res: CliResult, pattern: RegExp): void {
  assert.notEqual(res.code, 0, `${label}: expected failure, got exit 0\nstdout: ${res.stdout}`);
  assert.match(res.stderr, pattern, `${label}: stderr ${res.stderr}`);
}

interface StatusDecision {
  id: string;
  status: string;
  review_state: string;
  version: number;
  artifacts: Array<{ path: string; ready: boolean }>;
}

interface StatusJson {
  decisions: StatusDecision[];
  gates: Array<{ gate_id: string; decision: string }>;
  journal_seq: number;
  journal_ok: boolean;
  journal_error?: string;
}

function statusOf(project: string, home: string): StatusJson {
  return JSON.parse(ok("status --json", runCli(project, home, ["status", "--json"]))) as StatusJson;
}

function byId(status: StatusJson, id: string): StatusDecision {
  const d = status.decisions.find((x) => x.id === id);
  assert.ok(d, `decision ${id} missing from status`);
  return d;
}

const skip = await brimSkipReason();

test("BRIM end-to-end scenario through the CLI", { skip, timeout: 300_000 }, async () => {
  const home = await tempDir("tasteful-e2e-home-");
  const project = await tempDir("tasteful-e2e-proj-");
  const brimBefore = await hashFile(BRIM);

  // 1. init
  const initOut = ok("init", runCli(project, home, ["init", "--name", "brim-e2e"]));
  assert.match(initOut, /\.tasteful/);
  assert.ok((await fs.stat(path.join(project, ".tasteful", "project.json"))).isFile());

  // 2. brief + coverage
  const briefFile = path.join(project, "brief.md");
  const coverageFile = path.join(project, "coverage.json");
  await fs.writeFile(briefFile, "# BRIM Boutique\nMobile checkout first. Desktop 1440, mobile 390.\n", "utf8");
  await writeJson(coverageFile, {
    brief_id: "B-001",
    platforms: ["desktop-1440", "mobile-390"],
    screens: [
      {
        screen: "checkout-payment",
        states: ["default", "error", "loading", "empty"],
        breakpoints: ["mobile-390", "desktop-1440"],
        decision: "in",
        rationale: "payment failure is critical",
      },
      {
        screen: "marketing-about",
        states: ["default"],
        breakpoints: ["desktop-1440"],
        decision: "out",
        rationale: "single static page",
      },
    ],
  });
  const briefOut = ok("brief", runCli(project, home, ["brief", "--file", briefFile, "--coverage", coverageFile]));
  assert.match(briefOut, /B-001/);
  const briefHash = await hashFile(path.join(project, ".tasteful", "brief.md"));

  // 3. evidence fixture (written directly; it is input data, not a CLI step)
  const evidenceFile = path.join(project, "evidence-nav.md");
  await fs.writeFile(evidenceFile, "nav research: bottom tab bar\n", "utf8");
  const evidenceHash = await hashFile(evidenceFile);

  // 4. adapter check + info + export through the CLI (BRIM read-only source)
  const adapterOut = ok("adapter check", runCli(project, home, ["adapter", "check", "--canary", BRIM]));
  assert.match(adapterOut, /cli=0\.14\.0/);
  assert.match(adapterOut, /canary=true/);

  const info = JSON.parse(ok("info", runCli(project, home, ["info", "--file", BRIM]))) as {
    nodes: number;
    pages: Array<{ frames: unknown[] }>;
  };
  assert.equal(info.nodes, 1080);
  assert.ok(info.pages.length >= 1);
  assert.ok(info.pages[0].frames.length >= 30);

  const exportOut = ok(
    "export",
    runCli(project, home, [
      "export",
      "--file",
      BRIM,
      "--out",
      ".tasteful/exports/accueil.png",
      "--node",
      "01 — Accueil · Desktop",
      "--format",
      "png",
    ]),
  );
  const exportLine = exportOut.trim().split("\n")[0];
  const exportHash = exportLine.split(" ").pop() ?? "";
  assert.match(exportHash, /^[0-9a-f]{64}$/);
  assert.equal(await hashFile(path.join(project, ".tasteful/exports/accueil.png")), exportHash);

  // 5. decisions D001-D007: D001/D002 direct claim hits, D006 validation.
  const evidence = [{ type: "brief", ref: ".tasteful/brief.md", sha256: briefHash, captured_at: DAY }];
  const research = [{ type: "research", ref: "evidence-nav.md", sha256: evidenceHash, captured_at: DAY }];
  const exportArtifact = {
    path: ".tasteful/exports/accueil.png",
    sha256: exportHash,
    validator_version: 1,
    validated_at: DAY,
    checks: ["opens"],
    ready: true,
  };
  const claim = [{ claim_id: "C-PLATFORM-MOBILE", subject: "platform.mobile", predicate: "is", value: "mobile-web", scope: "project" }];
  const fixtures: Record<string, Decision> = {
    D001: decisionBase("D001", { title: "Platform scope", claims: claim, evidence, artifacts: [{ ...exportArtifact }] }),
    D002: decisionBase("D002", {
      title: "Mobile navigation",
      claims: claim,
      depends_on: ["D001"],
      evidence: research,
      artifacts: [{ ...exportArtifact }],
    }),
    D003: decisionBase("D003", { title: "Checkout flow", depends_on: ["D002"] }),
    D004: decisionBase("D004", { title: "About page" }),
    D005: decisionBase("D005", { title: "Design tokens", depends_on: ["D002"] }),
    D006: decisionBase("D006", {
      title: "Design review acceptance",
      status: "accepted",
      gate_ref: "G-DESIGN-REVIEW",
      depends_on: ["D003", "D005"],
      evidence,
      artifacts: [{ ...exportArtifact }],
    }),
    D007: decisionBase("D007", {
      title: "Handoff checklist",
      status: "accepted",
      gate_ref: "G-DESIGN-REVIEW",
      depends_on: ["D004"],
      evidence: research,
      artifacts: [{ ...exportArtifact }],
    }),
  };
  const decisionFiles: Record<string, string> = {};
  for (const id of ["D001", "D002", "D003", "D004", "D005", "D006", "D007"]) {
    const file = path.join(project, `${id}.json`);
    decisionFiles[id] = file;
    // Create proposed first so accept + acceptance can be tested separately.
    const proposed: Decision = { ...fixtures[id], status: "proposed", gate_ref: null };
    await writeJson(file, proposed);
    const out = ok(`decision create ${id}`, runCli(project, home, ["decision", "create", "--file", file]));
    assert.match(out, new RegExp(`^${id} v\\d+ [0-9a-f]{64}`));
  }
  let status = statusOf(project, home);
  assert.equal(status.decisions.length, 7);
  assert.equal(byId(status, "D007").review_state, "current");

  // 6. gate: self-approval and missing evidence leave no file; valid gate passes.
  const gateFile = path.join(project, "gate.json");
  const badGate: Gate = {
    gate_id: "G-BAD",
    stage: "visual-system",
    checklist: [{ criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: DAY }],
    decision: "pass",
    approver: OWNER,
    owner: OWNER,
    waivers: [],
  };
  await writeJson(gateFile, badGate);
  fails("gate self-approval", runCli(project, home, ["gate", "create", "--file", gateFile]), /E_SELF_APPROVAL/);
  await assert.rejects(fs.stat(path.join(project, ".tasteful", "gates", "G-BAD.json")));

  const missingEvidence: Gate = {
    ...badGate,
    gate_id: "G-BAD",
    approver: LEAD,
    checklist: [{ criterion: "contrast AA", evidence_ref: "", verifier_role: "accessibility", verdict: "pass", date: DAY }],
  };
  await writeJson(gateFile, missingEvidence);
  fails("gate missing evidence", runCli(project, home, ["gate", "create", "--file", gateFile]), /E_GATE_BLOCKED|E_SCHEMA/);
  await assert.rejects(fs.stat(path.join(project, ".tasteful", "gates", "G-BAD.json")));

  const goodGate: Gate = {
    gate_id: "G-DESIGN-REVIEW",
    stage: "visual-system",
    checklist: [{ criterion: "contrast AA", evidence_ref: "artifacts/contrast.json", verifier_role: "accessibility", verdict: "pass", date: DAY }],
    decision: "pass",
    approver: LEAD,
    owner: OWNER,
    waivers: [],
  };
  await writeJson(gateFile, goodGate);
  const gateApproval = ok("gate accept", runCli(project, home, ["gate", "accept", "--file", gateFile, "--approver", LEAD])).trim();
  assert.match(gateApproval, /^[0-9a-f]{64}$/);
  assert.match(
    ok("gate create", runCli(project, home, ["gate", "create", "--file", gateFile, "--approval", gateApproval])),
    /^G-DESIGN-REVIEW/m,
  );

  // 7. Fresh validation must run before acceptance: it executes the recorded
  // checks, writes a passing record, and refreshes validated_at/ready.
  for (const id of ["D006", "D007"]) {
    const validateOut = ok(
      `validate ${id}`,
      runCli(project, home, ["validate", "--decision", id, "--artifact", ".tasteful/exports/accueil.png"]),
    );
    assert.match(validateOut, /^OK /m);
  }
  const recordNames = await fs.readdir(path.join(project, ".tasteful", "validations"));
  assert.ok(recordNames.some((n) => n.startsWith("D006-")), "D006 validation record missing");
  assert.ok(recordNames.some((n) => n.startsWith("D007-")), "D007 validation record missing");
  for (const id of ["D006", "D007"]) {
    const stored = JSON.parse(await fs.readFile(path.join(project, ".tasteful", "decisions", `${id}.json`), "utf8")) as Decision;
    delete stored.review_state;
    delete stored.decision_hash;
    await writeJson(decisionFiles[id], { ...stored, status: "accepted" as const, gate_ref: "G-DESIGN-REVIEW" });
  }

  // 8. accepted decisions: no approval => rejected; human accept => accepted.
  fails(
    "accept without approval",
    runCli(project, home, ["decision", "create", "--file", decisionFiles.D006]),
    /E_ACCEPT_NO_APPROVAL/,
  );
  const approval6 = ok("accept D006", runCli(project, home, ["accept", "--file", decisionFiles.D006, "--approver", LEAD])).trim();
  assert.match(approval6, /^[0-9a-f]{64}$/);
  assert.match(
    ok("accepted D006", runCli(project, home, ["decision", "create", "--file", decisionFiles.D006, "--approval", approval6])),
    /^D006 v\d+ /,
  );
  fails(
    "accept approval replay",
    runCli(project, home, ["decision", "create", "--file", decisionFiles.D006, "--approval", approval6]),
    /E_APPROVAL_REPLAY|E_APPROVAL_MUTATED|E_APPROVAL_DENIED|E_ACCEPT_NO_APPROVAL/,
  );

  const approval7 = ok("accept D007", runCli(project, home, ["accept", "--file", decisionFiles.D007, "--approver", LEAD])).trim();
  assert.match(approval7, /^[0-9a-f]{64}$/);
  assert.notEqual(approval7, approval6);
  assert.match(
    ok("accepted D007", runCli(project, home, ["decision", "create", "--file", decisionFiles.D007, "--approval", approval7])),
    /^D007 v\d+ /,
  );

  // 9. approve --grant / --deny round-trip (fs_write operation digest).
  const fsTarget = path.join(project, "evidence-nav.md");
  const grantArgs = [
    "approve",
    "--grant",
    "--tool",
    "fs_write",
    "--target",
    fsTarget,
    "--content",
    "nav research: bottom tab bar\n",
    "--params-json",
    '{"path":"evidence-nav.md"}',
    "--approver",
    OWNER,
  ];
  const grantDigest = ok("approve --grant", runCli(project, home, grantArgs)).trim();
  assert.match(grantDigest, /^[0-9a-f]{64}$/);
  assert.match(ok("approve --list", runCli(project, home, ["approve", "--list"])), new RegExp(grantDigest.slice(0, 16)));
  const denyDigest = ok(
    "approve --deny",
    runCli(project, home, [...grantArgs.slice(0, 1), "--deny", ...grantArgs.slice(2)]),
  ).trim();
  assert.equal(denyDigest, grantDigest);
  assert.match(ok("approve --list after deny", runCli(project, home, ["approve", "--list"])), /no pending approvals/);
  fails("approve --grant usage", runCli(project, home, ["approve", "--grant"]), /E_USAGE/);

  // 10. scope change: exact normative closure through the CLI.
  const invOut = ok(
    "invalidate",
    runCli(project, home, [
      "invalidate",
      "--claim",
      "C-PLATFORM-MOBILE",
      "--old",
      "mobile-web",
      "--new",
      "mobile-web+ios",
      "--reason",
      "sponsor adds a native iOS app",
      "--author",
      OWNER,
    ]),
  );
  assert.match(invOut, /^E-[A-Za-z0-9-]+/);
  assert.match(invOut, /^D001 stale$/m);
  assert.match(invOut, /^D002 stale$/m);
  assert.match(invOut, /^D003 needs_review$/m);
  assert.match(invOut, /^D005 needs_review$/m);
  assert.match(invOut, /^D006 invalidated$/m);
  assert.doesNotMatch(invOut, /^D004 /m);
  assert.doesNotMatch(invOut, /^D007 /m);

  status = statusOf(project, home);
  assert.deepEqual(Object.fromEntries(status.decisions.map((d) => [d.id, d.review_state])), {
    D001: "stale",
    D002: "stale",
    D003: "needs_review",
    D004: "current",
    D005: "needs_review",
    D006: "invalidated",
    D007: "current",
  });
  assert.equal(byId(status, "D007").status, "accepted");
  for (const id of ["D001", "D002", "D006"]) {
    const d = byId(status, id);
    assert.ok(d.artifacts.length > 0, `${id}: expected recorded artifacts`);
    for (const a of d.artifacts) assert.equal(a.ready, false, `${id}:${a.path} must not be ready`);
  }
  for (const a of byId(status, "D007").artifacts) assert.equal(a.ready, true);

  // 11. artifact drift on a decision that was current before mutation.
  await fs.appendFile(path.join(project, ".tasteful/exports/accueil.png"), Buffer.from([0]));
  const driftOut = ok(
    "validate drift",
    runCli(project, home, ["validate", "--decision", "D007", "--artifact", ".tasteful/exports/accueil.png"]),
  );
  assert.match(driftOut, /^DRIFT /m);
  status = statusOf(project, home);
  assert.equal(byId(status, "D007").review_state, "needs_review");
  assert.equal(byId(status, "D007").status, "proposed");
  for (const a of byId(status, "D007").artifacts) assert.equal(a.ready, false);
  assert.equal(byId(status, "D004").review_state, "current");

  // 12. deterministic agent wiring smoke through the real pi session.
  const runOut = ok("run", runCli(project, home, ["run", "--prompt", "Check decision D007 and the journal.", "--model", "mock"]));
  assert.match(runOut, /tools: run_journal_read/);
  assert.match(runOut, /last: run complete/);

  // 13. final status JSON: 7 decisions, healthy journal, gate present.
  status = statusOf(project, home);
  assert.equal(status.decisions.length, 7);
  assert.equal(status.journal_ok, true);
  assert.ok(status.journal_seq > 10, `journal_seq=${status.journal_seq}`);
  assert.ok(status.gates.some((g) => g.gate_id === "G-DESIGN-REVIEW" && g.decision === "pass"));
  assert.equal(byId(status, "D006").review_state, "invalidated");
  assert.equal(byId(status, "D007").review_state, "needs_review");

  // 14. product identity + BRIM untouched.
  assert.match(ok("--version", runCli(project, home, ["--version"])), /^tasteful \d+\.\d+\.\d+/);
  const help = ok("--help", runCli(project, home, ["--help"]));
  assert.ok(!/pi\.dev|earendil/i.test(help));
  assert.equal(await hashFile(BRIM), brimBefore);
});
