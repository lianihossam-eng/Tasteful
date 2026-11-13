import { rejectsWithCode } from "../assert-code.js";
/** Status + journal-read honesty: chain verification, not optimistic flags. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initProject, writeGate, withLock } from "../../src/design/store.js";
import { validateGate } from "../../src/design/schema.js";
import { appendJournal, verifyJournal } from "../../src/host/journal.js";
import { cmdStatus, makeCtx } from "../../src/cli/commands.js";
import { decisionUpsert, runJournalRead, type ToolContext } from "../../src/host/tools.js";
import { decisionBase, tempDir } from "../helpers.js";

async function seed() {
  const dir = await tempDir("tasteful-status-");
  const p = await initProject(dir, "status", "0.1.0");
  const tc = makeCtx(dir);
  await withLock(p, async () => {
    await appendJournal(p, tc.journal, { kind: "command", actor: "human", payload: { command: "init" } });
    await appendJournal(p, tc.journal, { kind: "tool_call", actor: "agent", payload: { tool: "fs_read", path: "a" } });
  });
  return { dir, p, tc };
}

async function corruptSecondEntry(tc: ToolContext): Promise<void> {
  const file = path.join(tc.project.journal, "run.jsonl");
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  const rec = JSON.parse(lines[1]) as { payload: Record<string, unknown> };
  rec.payload.injected = true; // payload_hash left stale -> chain must fail
  lines[1] = JSON.stringify(rec);
  await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
}

test("status reports a verified journal", async () => {
  const { dir, p } = await seed();
  assert.equal((await verifyJournal(p)).length, 2);
  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    journal_ok: boolean; journal_seq: number; journal_error?: string;
  };
  assert.equal(st.journal_ok, true);
  assert.equal(st.journal_seq, 2);
  assert.equal(st.journal_error, undefined);
  assert.match(await cmdStatus({ project: dir }, false), /journal: seq=2 ok=true/);
});

test("status reports corrupt journal as not ok without throwing", async () => {
  const { dir, tc } = await seed();
  await corruptSecondEntry(tc);
  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    journal_ok: boolean; journal_seq: number; journal_error?: string;
  };
  assert.equal(st.journal_ok, false);
  assert.equal(st.journal_seq, -1);
  assert.match(st.journal_error ?? "", /hash|chain|seq/i);
  assert.match(await cmdStatus({ project: dir }, false), /ok=false/);
});

test("run_journal_read verifies the chain and refuses corruption", async () => {
  const { tc } = await seed();
  const ok = await runJournalRead(tc, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 2);
  await corruptSecondEntry(tc);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
});

test("status treats a never-written journal on a fresh project as empty", async () => {
  const dir = await tempDir("tasteful-status-fresh-");
  await initProject(dir, "fresh", "0.1.0");
  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    journal_ok: boolean; journal_seq: number; journal_error?: string;
  };
  assert.equal(st.journal_ok, true);
  assert.equal(st.journal_seq, 0);
  assert.equal(st.journal_error, undefined);
  assert.match(await cmdStatus({ project: dir }, false), /journal: seq=0 ok=true/);
});

test("status refuses a missing journal once the project holds state", async () => {
  const dir = await tempDir("tasteful-status-missing-");
  const p = await initProject(dir, "missing", "0.1.0");
  const tc = makeCtx(dir);
  await decisionUpsert(tc, { decision: decisionBase("D0001") });
  await fs.rm(path.join(p.journal, "run.jsonl"));
  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    journal_ok: boolean; journal_seq: number; journal_error?: string;
  };
  assert.equal(st.journal_ok, false);
  assert.equal(st.journal_seq, -1);
  assert.match(st.journal_error ?? "", /missing/i);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
});

function pendingGate(gateId: string) {
  return validateGate({
    gate_id: gateId,
    stage: "visual-system",
    checklist: [
      {
        criterion: "contrast AA",
        evidence_ref: "artifacts/contrast.json",
        verifier_role: "accessibility",
        verdict: "pass",
        date: "2026-11-11",
      },
    ],
    decision: "pending",
    approver: "lead@example",
    owner: "designer@example",
    waivers: [],
  });
}

test("status keeps readable gates and reports per-gate errors without failing", async () => {
  const { dir, p } = await seed();
  await writeGate(p, pendingGate("G-GOOD"));
  await fs.writeFile(path.join(p.gates, "G-BROKEN.json"), "{not json", "utf8");
  const bad = pendingGate("G-BAD");
  await fs.writeFile(
    path.join(p.gates, "G-SCHEMA.json"),
    JSON.stringify({ ...bad, checklist: [] }),
    "utf8",
  );
  const mismatch = pendingGate("G-DECLARED");
  await fs.writeFile(path.join(p.gates, "G-OTHER.json"), JSON.stringify(mismatch), "utf8");

  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    gates: Array<{ gate_id: string; decision: string }>;
    gate_errors?: Array<{ file: string; error: string }>;
    journal_ok: boolean;
    journal_seq: number;
  };
  assert.deepEqual(st.gates, [{ gate_id: "G-GOOD", decision: "pending" }]);
  assert.equal(st.gate_errors?.length, 3);
  assert.deepEqual(
    st.gate_errors?.map((e) => e.file),
    ["G-BROKEN.json", "G-OTHER.json", "G-SCHEMA.json"],
  );
  assert.ok(st.gate_errors?.every((e) => e.error.length > 0));
  // Journal health is independent and still honest.
  assert.equal(st.journal_ok, true);
  assert.equal(st.journal_seq, 2);

  const human = await cmdStatus({ project: dir }, false);
  assert.match(human, /gates: 1 ok, 3 errors/);
  assert.match(human, /gate error: G-BROKEN\.json:/);
  assert.match(human, /journal: seq=2 ok=true/);
});

test("status treats a missing gates directory as no gates, not an error", async () => {
  const { dir, p } = await seed();
  await fs.rm(p.gates, { recursive: true, force: true });
  const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
    gates: unknown[];
    gate_errors?: unknown[];
    journal_ok: boolean;
  };
  assert.deepEqual(st.gates, []);
  assert.equal(st.gate_errors, undefined);
  assert.equal(st.journal_ok, true);
});

test(
  "status reports an unreadable gate file as a gate error",
  { skip: process.getuid?.() === 0 ? "root bypasses chmod permissions" : false },
  async () => {
    const { dir, p } = await seed();
    await writeGate(p, pendingGate("G-GOOD"));
    const broken = path.join(p.gates, "G-UNREADABLE.json");
    await fs.writeFile(broken, JSON.stringify(pendingGate("G-UNREADABLE")), "utf8");
    await fs.chmod(broken, 0o000);
    try {
      const st = JSON.parse(await cmdStatus({ project: dir }, true)) as {
        gates: Array<{ gate_id: string }>;
        gate_errors?: Array<{ file: string; error: string }>;
        journal_ok: boolean;
      };
      assert.deepEqual(st.gates.map((g) => g.gate_id), ["G-GOOD"]);
      assert.equal(st.gate_errors?.length, 1);
      assert.equal(st.gate_errors?.[0]?.file, "G-UNREADABLE.json");
      assert.match(st.gate_errors?.[0]?.error ?? "", /EACCES|permission/i);
      assert.equal(st.journal_ok, true);
      assert.match(await cmdStatus({ project: dir }, false), /gates: 1 ok, 1 errors/);
    } finally {
      await fs.chmod(broken, 0o600);
    }
  },
);
