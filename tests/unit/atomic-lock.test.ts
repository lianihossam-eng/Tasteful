/** Atomic writes + lock serialization + stale recovery. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initProject, projectPaths, withLock, writeFileAtomic } from "../../src/design/store.js";
import { tempDir } from "../helpers.js";

test("atomic write leaves old content intact on crash simulation", async () => {
  const dir = await tempDir("tasteful-atomic-");
  const target = path.join(dir, "f.txt");
  await fs.writeFile(target, "old", "utf8");
  // Simulate crash: temp file exists but rename never happens.
  const tmp = path.join(dir, ".tmp-crash");
  await fs.writeFile(tmp, "new", "utf8");
  assert.equal(await fs.readFile(target, "utf8"), "old");
  await writeFileAtomic(target, "new");
  assert.equal(await fs.readFile(target, "utf8"), "new");
});

test("two writers serialize, no lost update", async () => {
  const dir = await tempDir("tasteful-lock-");
  const p = await initProject(dir, "locktest", "0.1.0");
  const order: string[] = [];
  // Real delay: exercises actual lockdir serialization across concurrent
  // holders; fake timers cannot drive fs-level mutual exclusion. Start the
  // second writer only after the first holds the lock: both calls begin with
  // async state-root probes, so promise creation order alone does not decide
  // acquisition order.
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = withLock(p, async () => {
    order.push("a-start");
    entered();
    await new Promise((r) => setTimeout(r, 150));
    order.push("a-end");
  });
  await holding;
  const fast = withLock(p, async () => {
    order.push("b");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("stale lock (dead pid) is recovered", async () => {
  const dir = await tempDir("tasteful-stale-");
  const p = projectPaths(dir);
  await fs.mkdir(p.tasteful, { recursive: true });
  await fs.mkdir(p.lock, { recursive: true });
  await fs.writeFile(path.join(p.lock, "owner.json"), JSON.stringify({ pid: 99999999, at: Date.now() }), "utf8");
  const res = await withLock(p, async () => "ok", { timeoutMs: 2000 });
  assert.equal(res, "ok");
});
