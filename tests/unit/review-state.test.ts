/** Derived review_state: authored values rejected, updates preserve state. */
import { rejectsWithCode, throwsWithCode } from "../assert-code.js";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { validateDecision } from "../../src/design/schema.js";
import {
  initProject,
  readDecision,
  upsertDecision,
  withLock,
} from "../../src/design/store.js";
import { appendJournal } from "../../src/host/journal.js";
import { decisionInvalidate, makeToolContext } from "../../src/host/tools.js";
import { decisionBase, tempDir } from "../helpers.js";

const CLAIM = {
  claim_id: "C-PLATFORM-MOBILE",
  subject: "platform.mobile",
  predicate: "is",
  value: "mobile-web",
  scope: "project",
};

function ctxFor(root: string) {
  return makeToolContext(root, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "human");
}

test("authored review_state and decision_hash are rejected with E_SCHEMA", async () => {
  const dir = await tempDir("tasteful-derived-");
  const p = await initProject(dir, "derived", "0.1.0");
  throwsWithCode(
    () => validateDecision({ ...decisionBase("D001"), review_state: "stale" }),
    "E_SCHEMA",
  );
  throwsWithCode(
    () => validateDecision({ ...decisionBase("D001"), decision_hash: "0".repeat(64) }),
    "E_SCHEMA",
  );
  await rejectsWithCode(
    upsertDecision(p, { ...decisionBase("D001"), review_state: "stale" }),
    "E_SCHEMA",
  );
  await rejectsWithCode(
    upsertDecision(p, { ...decisionBase("D001"), decision_hash: "0".repeat(64) }),
    "E_SCHEMA",
  );
});

test("new decisions start current; a normal update preserves invalidation", async () => {
  const dir = await tempDir("tasteful-review-state-");
  const p = await initProject(dir, "review-state", "0.1.0");
  // Seed valid journal history before raw state: invalidation preflights it.
  const journalCtx = ctxFor(dir).journal;
  await withLock(p, () => appendJournal(p, journalCtx, { kind: "command", actor: "human", payload: { command: "init" } }));

  await upsertDecision(p, decisionBase("D001", {
    claims: [CLAIM],
    artifacts: [{
      path: "art.bin",
      sha256: "a".repeat(64),
      validator_version: 1,
      validated_at: "2026-11-11",
      checks: ["opens"],
      ready: true,
    }],
  }));
  assert.equal((await readDecision(p, "D001")).review_state, "current");

  const inv = await decisionInvalidate(ctxFor(dir), {
    claim_id: CLAIM.claim_id,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    reason: "scope change",
    author: "designer@example",
  });
  assert.equal(inv.affected.D001, "stale");
  const stale = await readDecision(p, "D001");
  assert.equal(stale.review_state, "stale");
  assert.deepEqual(stale.artifacts.map((a) => a.ready), [false]);

  // A title-only authored update must not reset the derived invalidation.
  const updated = await upsertDecision(p, decisionBase("D001", {
    version: 2,
    title: "Platform scope (revised)",
    claims: [CLAIM],
  }));
  assert.equal(updated.review_state, "stale");
  const reread = await readDecision(p, "D001");
  assert.equal(reread.review_state, "stale");
  assert.equal(reread.title, "Platform scope (revised)");
  assert.equal(typeof reread.decision_hash, "string");

  // And a model attempt to author the state back to current is rejected.
  await rejectsWithCode(
    upsertDecision(p, {
      ...decisionBase("D001", { version: 3, claims: [CLAIM] }),
      review_state: "current",
    }),
    "E_SCHEMA",
  );
  assert.equal((await readDecision(p, "D001")).review_state, "stale");
});

test("stored decision tampering and filename/id mismatch are rejected on read", async () => {
  const dir = await tempDir("tasteful-tamper-");
  const p = await initProject(dir, "tamper", "0.1.0");
  await upsertDecision(p, decisionBase("D001"));

  // Change authored content while keeping the stored hash -> E_HASH_MISMATCH.
  const file = path.join(p.decisions, "D001.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  raw.title = "Tampered title";
  await fs.writeFile(file, JSON.stringify(raw), "utf8");
  await rejectsWithCode(readDecision(p, "D001"), "E_HASH_MISMATCH");

  // A file whose stored id does not match its filename is rejected.
  await fs.writeFile(path.join(p.decisions, "D002.json"), JSON.stringify(raw), "utf8");
  await rejectsWithCode(readDecision(p, "D002"), "E_SCHEMA");
});

test("review_state is not accepted on any authored decision", async () => {
  const dir = await tempDir("tasteful-review-state-new-");
  const p = await initProject(dir, "review-state-new", "0.1.0");
  for (const state of ["current", "stale", "needs_review", "invalidated", "blocked"]) {
    await rejectsWithCode(
      upsertDecision(p, { ...decisionBase("D010"), review_state: state }),
      "E_SCHEMA",
    );
  }
});
