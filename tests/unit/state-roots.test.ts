/** State-root revalidation: symlinks swapped after init must fail every op. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { rejectsWithCode } from "../assert-code.js";
import { cmdStatus, makeCtx } from "../../src/cli/commands.js";
import { initProject, withLock } from "../../src/design/store.js";
import { decisionUpsert, fsWrite } from "../../src/host/tools.js";
import { decisionBase, tempDir, withTempHome } from "../helpers.js";

test("symlinked exports after init fails writes and touches nothing outside", async () => {
  await withTempHome(async () => {
    const dir = await tempDir("tasteful-state-");
    const p = await initProject(dir, "state", "0.1.0");
    const outside = await tempDir("tasteful-outside-");
    await fs.rm(p.exports, { recursive: true, force: true });
    await fs.symlink(outside, p.exports);
    const tc = makeCtx(dir);
    await rejectsWithCode(fsWrite(tc, { path: ".tasteful/exports/evil.txt", content: "ESCAPED" }), "E_PATH_SYMLINK");
    // Any fs write revalidates the whole state layout, not just the target root.
    await rejectsWithCode(fsWrite(tc, { path: "evil.txt", content: "ESCAPED" }), "E_PATH_SYMLINK");
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("exports symlinked to another state root inside the project is still rejected", async () => {
  await withTempHome(async () => {
    const dir = await tempDir("tasteful-state-");
    const p = await initProject(dir, "state", "0.1.0");
    await fs.rm(p.exports, { recursive: true, force: true });
    await fs.symlink(p.events, p.exports);
    const tc = makeCtx(dir);
    await rejectsWithCode(fsWrite(tc, { path: ".tasteful/exports/evil.txt", content: "ESCAPED" }), "E_PATH_SYMLINK");
  });
});

test("symlinked decisions after init fails decision writes and touches nothing outside", async () => {
  await withTempHome(async () => {
    const dir = await tempDir("tasteful-state-");
    const p = await initProject(dir, "state", "0.1.0");
    const outside = await tempDir("tasteful-outside-");
    await fs.rm(p.decisions, { recursive: true, force: true });
    await fs.symlink(outside, p.decisions);
    const tc = makeCtx(dir);
    await rejectsWithCode(decisionUpsert(tc, { decision: decisionBase("D002") }), "E_PATH_SYMLINK");
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("symlinked .tasteful after init fails lock, init, and status safely", async () => {
  await withTempHome(async () => {
    const dir = await tempDir("tasteful-state-");
    const p = await initProject(dir, "state", "0.1.0");
    const outside = await tempDir("tasteful-outside-");
    await fs.rm(p.tasteful, { recursive: true, force: true });
    await fs.symlink(outside, p.tasteful);
    await rejectsWithCode(withLock(p, async () => "ok"), "E_PATH_SYMLINK");
    await rejectsWithCode(initProject(dir, "state", "0.1.0"), "E_PATH_SYMLINK");
    await rejectsWithCode(cmdStatus({ project: dir }, true), "E_PATH_SYMLINK");
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("state root that is a regular file is rejected", async () => {
  await withTempHome(async () => {
    const dir = await tempDir("tasteful-state-");
    const p = await initProject(dir, "state", "0.1.0");
    await fs.rm(p.gates, { recursive: true, force: true });
    await fs.writeFile(p.gates, "not a dir", "utf8");
    const tc = makeCtx(dir);
    await rejectsWithCode(decisionUpsert(tc, { decision: decisionBase("D002") }), "E_PATH");
  });
});
