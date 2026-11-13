import { rejectsWithCode } from "../assert-code.js";
/** index.json rebuild is byte-identical; store rejects cycles + bad accepted. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  initProject,
  rebuildIndex,
  upsertDecision,
} from "../../src/design/store.js";
import { decisionBase, tempDir } from "../helpers.js";

test("rebuild twice -> byte-identical index", async () => {
  const dir = await tempDir("tasteful-index-");
  const p = await initProject(dir, "idx", "0.1.0");
  await upsertDecision(p, decisionBase("D001"));
  await upsertDecision(p, decisionBase("D002", { depends_on: ["D001"] }));
  const a = await fs.readFile(path.join(p.decisions, "index.json"), "utf8");
  await rebuildIndex(p);
  const b = await fs.readFile(path.join(p.decisions, "index.json"), "utf8");
  assert.equal(a, b);
  const idx = JSON.parse(a) as { edges: Array<{ from: string; to: string }> };
  assert.deepEqual(idx.edges, [{ from: "D002", to: "D001" }]);
});

test("upsert with missing dep rejected", async () => {
  const dir = await tempDir("tasteful-dep-");
  const p = await initProject(dir, "dep", "0.1.0");
  await rejectsWithCode(
    upsertDecision(p, decisionBase("D001", { depends_on: ["D999"] })),
    "E_DEP_MISSING",
  );
});

test("upsert creating a cycle rejected", async () => {
  const dir = await tempDir("tasteful-cyc-");
  const p = await initProject(dir, "cyc", "0.1.0");
  await upsertDecision(p, decisionBase("D001"));
  await upsertDecision(p, decisionBase("D002", { depends_on: ["D001"] }));
  await rejectsWithCode(
    upsertDecision(p, decisionBase("D001", { version: 2, depends_on: ["D002"] })),
    "E_CYCLE",
  );
});

test("accepted without evidence/gate/approval rejected", async () => {
  const dir = await tempDir("tasteful-acc-");
  const p = await initProject(dir, "acc", "0.1.0");
  const d = decisionBase("D001", { status: "accepted" });
  await rejectsWithCode(upsertDecision(p, d), "E_ACCEPT_NO_EVIDENCE");
});
