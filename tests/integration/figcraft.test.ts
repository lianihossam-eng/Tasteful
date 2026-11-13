/** FigCraft integration: BRIM info read-only + tiny fixture export. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { figcraftExport, figcraftInfo } from "../../src/artcraft/figcraft.js";
import { hashFile } from "../../src/design/hashes.js";
import { BRIM, brimSkipReason, tempDir } from "../helpers.js";
import { generateTinyFixture } from "../fixtures/generate.js";
import { PINNED_CLI_VERSION } from "../../src/artcraft/matrix.js";

test("BRIM info is read-only and has expected shape", async (t) => {
  const skip = await brimSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const before = await hashFile(BRIM);
  const mtimeBefore = (await fs.stat(BRIM)).mtimeMs;
  const res = await figcraftInfo(BRIM, { read: [path.dirname(BRIM)], write: [] });
  const info = res.info as { nodes: number; pages: Array<{ frames: unknown[] }>; name: string };
  assert.equal(info.nodes, 1080);
  assert.equal(info.pages.length, 1);
  assert.ok(info.pages[0].frames.length >= 30);
  assert.equal(res.pair.cliVersion, PINNED_CLI_VERSION);
  assert.ok(!res.argv.includes("--automation-write-root"), "info must not carry a write root");
  assert.equal(await hashFile(BRIM), before);
  assert.equal((await fs.stat(BRIM)).mtimeMs, mtimeBefore);
});

test("tiny fixture generates deterministically (<20 nodes)", async () => {
  const dir = await tempDir("tasteful-fixture-");
  const a = await generateTinyFixture(path.join(dir, "a"));
  const b = await generateTinyFixture(path.join(dir, "b"));
  assert.equal(a.scriptHash, b.scriptHash);
  const res = await figcraftInfo(a.file, { read: [dir], write: [] });
  const info = res.info as { nodes: number };
  assert.ok(info.nodes < 20, `nodes=${info.nodes}`);
});

test("tiny fixture exports to temp dir", async () => {
  const dir = await tempDir("tasteful-export-");
  const { file } = await generateTinyFixture(path.join(dir, "gen"));
  const out = path.join(dir, "out");
  await fs.mkdir(out, { recursive: true });
  const res = await figcraftExport(
    { file, out: path.join(out, "tiny.png"), format: "png" },
    { read: [dir], write: [out] },
  );
  assert.equal(res.files.length, 1);
  const h = await hashFile(res.files[0]);
  assert.match(h, /^[0-9a-f]{64}$/);
});
