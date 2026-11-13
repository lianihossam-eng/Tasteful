/** Journal scale + integrity: no silent read clamp, strict chain, hardened leaf. */
import { rejectsWithCode } from "../assert-code.js";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initProject, writeEvent, writeGate } from "../../src/design/store.js";
import { validateGate } from "../../src/design/schema.js";
import { appendJournal, preflightJournal, readJournalEntries, verifyJournal } from "../../src/host/journal.js";
import { decisionUpsert, runJournalRead } from "../../src/host/tools.js";
import { cmdStatus, makeCtx } from "../../src/cli/commands.js";
import { decisionBase, tempDir } from "../helpers.js";

interface StatusReport {
  journal_ok: boolean;
  journal_seq: number;
  journal_error?: string;
}

interface JournalLine {
  seq: number;
}

function statusOf(raw: string): StatusReport {
  return JSON.parse(raw) as StatusReport; // boundary: host-rendered status JSON
}

function lineSeq(line: string): number {
  const parsed = JSON.parse(line) as JournalLine; // boundary: host-written journal line
  return parsed.seq;
}

function entrySeq(entry: unknown): number {
  if (typeof entry !== "object" || entry === null || !("seq" in entry) || typeof entry.seq !== "number") {
    assert.fail("journal entry missing numeric seq");
  }
  return entry.seq;
}

async function freshProject(prefix: string) {
  const dir = await tempDir(prefix);
  const p = await initProject(dir, "journal", "0.1.0");
  return { dir, p, tc: makeCtx(dir), leaf: path.join(p.journal, "run.jsonl") };
}

const input = (i: number) => ({
  kind: "tool_call" as const,
  actor: "agent" as const,
  payload: { tool: "fs_read", i },
});

test("journal beyond 1,000 entries: no clamp, strict sequence, honest status", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-cap-");
  for (let i = 0; i < 1004; i++) await appendJournal(p, tc.journal, input(i));
  const raw = (await fs.readFile(leaf, "utf8")).trim().split("\n");
  assert.equal(raw.length, 1004);
  assert.deepEqual(raw.map(lineSeq), Array.from({ length: 1004 }, (_, i) => i + 1));
  // Internal read must not truncate either.
  assert.equal((await readJournalEntries(p)).length, 1004);
  const verified = await verifyJournal(p);
  assert.equal(verified.length, 1004);
  assert.equal(verified[1003]!.seq, 1004);
  const st = statusOf(await cmdStatus({ project: dir }, true));
  assert.equal(st.journal_ok, true);
  assert.equal(st.journal_seq, 1004);
  assert.equal(st.journal_error, undefined);
  // The model-facing window still caps at 1,000 and pages by seq.
  const page = await runJournalRead(tc, { limit: 5000 });
  assert.equal(page.ok, true);
  assert.equal(page.entries.length, 1000);
  assert.deepEqual(page.entries.map(entrySeq), Array.from({ length: 1000 }, (_, i) => i + 1));
  const tail = await runJournalRead(tc, { seq_from: 1000 });
  assert.deepEqual(tail.entries.map(entrySeq), [1000, 1001, 1002, 1003, 1004]);
});

test("duplicate seq is corruption: verify, status, and model read all refuse", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-dup-");
  for (let i = 0; i < 1001; i++) await appendJournal(p, tc.journal, input(i));
  const lines = (await fs.readFile(leaf, "utf8")).trim().split("\n");
  assert.equal(lineSeq(lines[1000]!), 1001);
  // Bypass appendJournal: hand-write a duplicate seq, valid hashes intact.
  await fs.appendFile(leaf, lines[1000]! + "\n", "utf8");
  await rejectsWithCode(verifyJournal(p), "E_JOURNAL_CORRUPT");
  const st = statusOf(await cmdStatus({ project: dir }, true));
  assert.equal(st.journal_ok, false);
  assert.equal(st.journal_seq, -1);
  assert.match(st.journal_error ?? "", /seq 1001/);
  assert.match(await cmdStatus({ project: dir }, false), /ok=false/);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
});

test("symlinked journal leaf is refused and the target is never written", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-symlink-");
  const outside = path.join(dir, "outside.jsonl");
  await fs.writeFile(outside, "", "utf8");
  await fs.symlink(outside, leaf);
  await rejectsWithCode(readJournalEntries(p), "E_JOURNAL_LEAF");
  await rejectsWithCode(verifyJournal(p), "E_JOURNAL_LEAF");
  await rejectsWithCode(appendJournal(p, tc.journal, input(0)), "E_JOURNAL_LEAF");
  const st = statusOf(await cmdStatus({ project: dir }, true));
  assert.equal(st.journal_ok, false);
  assert.match(st.journal_error ?? "", /symlink/i);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
  assert.equal(await fs.readFile(outside, "utf8"), "");
});

test(
  "unreadable journal is an error, never an empty journal",
  { skip: process.getuid?.() === 0 ? "root bypasses chmod permissions" : false },
  async () => {
    const { dir, p, tc, leaf } = await freshProject("tasteful-journal-unreadable-");
    await appendJournal(p, tc.journal, input(0));
    await fs.chmod(leaf, 0o000);
    try {
      await rejectsWithCode(readJournalEntries(p), "EACCES");
      const st = statusOf(await cmdStatus({ project: dir }, true));
      assert.equal(st.journal_ok, false);
      assert.match(st.journal_error ?? "", /EACCES|permission/i);
      await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
    } finally {
      await fs.chmod(leaf, 0o600);
    }
  },
);

test("journal path that is a directory is refused, not treated as empty", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-dir-");
  await fs.mkdir(leaf);
  await rejectsWithCode(readJournalEntries(p), "E_JOURNAL_LEAF");
  await rejectsWithCode(appendJournal(p, tc.journal, input(0)), "E_JOURNAL_LEAF");
  const st = statusOf(await cmdStatus({ project: dir }, true));
  assert.equal(st.journal_ok, false);
  assert.match(st.journal_error ?? "", /regular file/i);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
});

// ---- empty journal on a non-empty project is corruption ----

const pendingGate = () =>
  validateGate({
    gate_id: "G-DESIGN-REVIEW",
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

const changeEvent = () => ({
  event_id: `E-${new Date().toISOString().slice(0, 10)}-001`,
  claim_id: "C-PLATFORM-MOBILE",
  old_value: "mobile-web",
  new_value: "mobile-web+ios",
  source: "scope-change",
  occurred_at: new Date().toISOString().slice(0, 10),
  reason: "scope change",
  author: "designer@example",
});

async function assertEmptyWithStateIsCorruption(
  dir: string,
  p: Awaited<ReturnType<typeof initProject>>,
  tc: ReturnType<typeof makeCtx>,
  leaf: string,
): Promise<void> {
  await rejectsWithCode(verifyJournal(p), "E_JOURNAL_CORRUPT");
  await assert.rejects(verifyJournal(p), /journal file is empty/);
  const st = statusOf(await cmdStatus({ project: dir }, true));
  assert.equal(st.journal_ok, false);
  assert.equal(st.journal_seq, -1);
  assert.match(st.journal_error ?? "", /empty/);
  assert.match(await cmdStatus({ project: dir }, false), /ok=false[^\n]*empty/);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
  // The append must refuse to restart the chain, and must not write seq 1.
  await rejectsWithCode(appendJournal(p, tc.journal, input(0)), "E_JOURNAL_CORRUPT");
  assert.equal((await fs.readFile(leaf, "utf8")).trim(), "");
}

test("zero-byte journal with a decision is corruption; no seq-1 restart", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-empty-decision-");
  await decisionUpsert(tc, { decision: decisionBase("D0001") });
  await fs.writeFile(leaf, "", "utf8");
  await assertEmptyWithStateIsCorruption(dir, p, tc, leaf);
});

test("zero-byte journal with a gate is corruption; no seq-1 restart", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-empty-gate-");
  await appendJournal(p, tc.journal, input(0)); // state still empty: healthy seq 1
  await writeGate(p, pendingGate());
  await fs.writeFile(leaf, "", "utf8");
  await assertEmptyWithStateIsCorruption(dir, p, tc, leaf);
});

test("zero-byte journal with a change event is corruption; no seq-1 restart", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-empty-event-");
  await appendJournal(p, tc.journal, input(0));
  await writeEvent(p, changeEvent());
  await fs.writeFile(leaf, "", "utf8");
  await assertEmptyWithStateIsCorruption(dir, p, tc, leaf);
});

test("whitespace-only journal with state is corruption", async () => {
  const { dir, p, tc, leaf } = await freshProject("tasteful-journal-empty-ws-");
  await decisionUpsert(tc, { decision: decisionBase("D0001") });
  await fs.writeFile(leaf, "  \n\t\n\n", "utf8");
  await rejectsWithCode(verifyJournal(p), "E_JOURNAL_CORRUPT");
  await assert.rejects(verifyJournal(p), /journal file is empty/);
  assert.equal(statusOf(await cmdStatus({ project: dir }, true)).journal_ok, false);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
  await rejectsWithCode(appendJournal(p, tc.journal, input(0)), "E_JOURNAL_CORRUPT");
});

test("an empty project starts a journal at seq 1 (missing, zero-byte, or whitespace-only)", async () => {
  const missing = await freshProject("tasteful-journal-fresh-missing-");
  assert.deepEqual(await verifyJournal(missing.p), []);
  const first = await appendJournal(missing.p, missing.tc.journal, input(0));
  assert.equal(first.seq, 1);
  assert.deepEqual((await verifyJournal(missing.p)).map((e) => e.seq), [1]);

  const zero = await freshProject("tasteful-journal-fresh-zero-");
  await fs.writeFile(zero.leaf, "", "utf8");
  assert.deepEqual(await verifyJournal(zero.p), []);
  assert.equal((await appendJournal(zero.p, zero.tc.journal, input(0))).seq, 1);
  assert.deepEqual((await fs.readFile(zero.leaf, "utf8")).trim().split("\n").map(lineSeq), [1]);

  const whitespace = await freshProject("tasteful-journal-fresh-ws-");
  await fs.writeFile(whitespace.leaf, "\n   \n", "utf8");
  assert.deepEqual(await verifyJournal(whitespace.p), []);
  assert.equal((await appendJournal(whitespace.p, whitespace.tc.journal, input(0))).seq, 1);
  // The blank prefix is replaced, not carried into the restarted journal.
  assert.deepEqual((await fs.readFile(whitespace.leaf, "utf8")).trim().split("\n").map(lineSeq), [1]);
});

// ---- structurally invalid lines are corruption ----

async function seedTwo(prefix: string) {
  const f = await freshProject(prefix);
  await appendJournal(f.p, f.tc.journal, input(0));
  await appendJournal(f.p, f.tc.journal, input(1));
  const lines = (await fs.readFile(f.leaf, "utf8")).trim().split("\n");
  return { ...f, lines };
}

test("non-entry JSON lines are rejected, not silently dropped", async () => {
  const cases: Array<[string, string]> = [
    ["garbage object", '{"garbage":true}'],
    ["seq zero", '{"seq":0,"kind":"command"}'],
    ["missing seq", '{"kind":"command","actor":"human","payload":{}}'],
    ["null", "null"],
    ["array", "[1,2,3]"],
  ];
  for (const [label, bad] of cases) {
    const { dir, p, tc, leaf } = await seedTwo(`tasteful-journal-shape-${label.replace(/\W+/g, "-")}-`);
    await fs.appendFile(leaf, bad + "\n", "utf8");
    await rejectsWithCode(verifyJournal(p), "E_JOURNAL_CORRUPT");
    await assert.rejects(verifyJournal(p), /line 3 is not a journal entry/);
    const st = statusOf(await cmdStatus({ project: dir }, true));
    assert.equal(st.journal_ok, false, label);
    assert.equal(st.journal_seq, -1, label);
    assert.match(st.journal_error ?? "", /line 3 is not a journal entry/, label);
    await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
  }
});

test("a later valid line does not mask an earlier invalid line", async () => {
  const { dir, p, tc, leaf, lines } = await seedTwo("tasteful-journal-shape-middle-");
  await fs.writeFile(leaf, [lines[0]!, '{"garbage":true}', lines[1]!].join("\n") + "\n", "utf8");
  await rejectsWithCode(verifyJournal(p), "E_JOURNAL_CORRUPT");
  await assert.rejects(verifyJournal(p), /line 2 is not a journal entry/);
  assert.equal(statusOf(await cmdStatus({ project: dir }, true)).journal_ok, false);
  await rejectsWithCode(runJournalRead(tc, {}), "E_JOURNAL_CORRUPT");
});

test("blank lines are skipped and unknown extra fields are allowed", async () => {
  const { p, tc, leaf, lines } = await seedTwo("tasteful-journal-shape-ok-");
  const withExtra = JSON.parse(lines[0]!) as Record<string, unknown>;
  withExtra.future_field = "forward-compatible";
  await fs.writeFile(leaf, [JSON.stringify(withExtra), "", "   ", lines[1]!].join("\n") + "\n", "utf8");
  const verified = await verifyJournal(p);
  assert.deepEqual(verified.map((e) => e.seq), [1, 2]);
  const read = await readJournalEntries(p);
  assert.equal(read.length, 2);
  assert.equal((read[0] as unknown as Record<string, unknown>).future_field, "forward-compatible");
  assert.equal((await runJournalRead(tc, {})).entries.length, 2);
});

test("preflight fresh-start flag allows the first entry after the first state write", async () => {
  const { p, tc, leaf } = await freshProject("tasteful-journal-fresh-flag-");
  const pre = await preflightJournal(p);
  assert.equal(pre.freshStart, true);
  // The mutation (here: a direct gate write) makes state non-empty before the
  // journal append; the preflight flag marks this as the chain's first entry.
  await writeGate(p, pendingGate());
  const first = await appendJournal(p, tc.journal, input(0), { fresh_start: pre.freshStart });
  assert.equal(first.seq, 1);
  assert.deepEqual((await verifyJournal(p)).map((e) => e.seq), [1]);
  assert.deepEqual((await fs.readFile(leaf, "utf8")).trim().split("\n").map(lineSeq), [1]);

  const again = await preflightJournal(p);
  assert.equal(again.freshStart, false);
  assert.equal((await appendJournal(p, tc.journal, input(1))).seq, 2);
});
