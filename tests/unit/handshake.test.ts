/**
 * Adapter handshake: the pinned pair gates every info/export BEFORE spawn.
 * A fake figcraft-cli on PATH proves fail-closed behavior and that writes
 * never happen through an unsupported adapter; a pinned fake exercises the
 * canary (read roots, parse, hash) and the per-process pair cache.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  adapterCheck,
  PINNED_CLI_VERSION,
  requirePinnedPair,
  resetAdapterHandshakeCache,
} from "../../src/artcraft/matrix.js";
import { figcraftExport, figcraftInfo } from "../../src/artcraft/figcraft.js";
import { sha256Hex } from "../../src/design/hashes.js";
import { rejectsWithCode } from "../assert-code.js";
import { tempDir } from "../helpers.js";

interface FakeCli {
  dir: string;
  log: string;
  restore: () => void;
}

async function installFakeCli(opts: { version: string; info?: unknown }): Promise<FakeCli> {
  const dir = await tempDir("tasteful-fake-cli-");
  const log = path.join(dir, "calls.jsonl");
  const exe = path.join(dir, "figcraft-cli");
  const infoJson = JSON.stringify(opts.info ?? { nodes: 1, pages: [] });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.TASTEFUL_FAKE_LOG) fs.appendFileSync(process.env.TASTEFUL_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("figcraft-cli ${opts.version}"); process.exit(0); }
if (args[0] === "commands") { console.log("info\\nexport"); process.exit(0); }
if (args[0] === "info") { console.log(${JSON.stringify(infoJson)}); process.exit(0); }
if (args[0] === "export") {
  const i = args.indexOf("--out");
  if (i !== -1) fs.writeFileSync(args[i + 1], "fake-export");
  process.exit(0);
}
console.error("unexpected argv: " + args.join(" "));
process.exit(2);
`;
  await fs.writeFile(exe, script, "utf8");
  await fs.chmod(exe, 0o755);
  const prevPath = process.env.PATH;
  const prevLog = process.env.TASTEFUL_FAKE_LOG;
  process.env.PATH = `${dir}${path.delimiter}${prevPath ?? ""}`;
  process.env.TASTEFUL_FAKE_LOG = log;
  resetAdapterHandshakeCache();
  return {
    dir,
    log,
    restore: () => {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevLog === undefined) delete process.env.TASTEFUL_FAKE_LOG;
      else process.env.TASTEFUL_FAKE_LOG = prevLog;
      resetAdapterHandshakeCache();
    },
  };
}

async function calls(log: string): Promise<string[][]> {
  const text = await fs.readFile(log, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

test("unsupported fake CLI fails info before spawning info", async () => {
  const fake = await installFakeCli({ version: "9.9.9" });
  try {
    const dir = await tempDir("tasteful-handshake-");
    const file = path.join(dir, "source.figcraft");
    await fs.writeFile(file, "not-a-real-document", "utf8");
    await rejectsWithCode(figcraftInfo(file, { read: [dir], write: [] }), "E_UNSUPPORTED_PAIR");
    const invoked = await calls(fake.log);
    assert.deepEqual(invoked, [["--version"]], "info must not spawn after a failed pair check");
  } finally {
    fake.restore();
  }
});

test("unsupported fake CLI fails export before any output write", async () => {
  const fake = await installFakeCli({ version: "9.9.9" });
  try {
    const dir = await tempDir("tasteful-handshake-");
    const file = path.join(dir, "source.figcraft");
    const out = path.join(dir, "never-created.png");
    await fs.writeFile(file, "not-a-real-document", "utf8");
    await rejectsWithCode(
      figcraftExport({ file, out, format: "png" }, { read: [dir], write: [dir] }),
      "E_UNSUPPORTED_PAIR",
    );
    await assert.rejects(fs.stat(out), { code: "ENOENT" }, "unsupported adapter must not write output");
    const invoked = await calls(fake.log);
    assert.deepEqual(invoked, [["--version"]], "export must not spawn after a failed pair check");
  } finally {
    fake.restore();
  }
});

test("adapter check fails E_UNSUPPORTED_PAIR before the canary runs", async () => {
  const fake = await installFakeCli({ version: "9.9.9" });
  try {
    const dir = await tempDir("tasteful-canary-");
    const canary = path.join(dir, "canary.figcraft");
    await fs.writeFile(canary, "not-a-real-document", "utf8");
    await rejectsWithCode(adapterCheck(undefined, canary), "E_UNSUPPORTED_PAIR");
    const invoked = await calls(fake.log);
    assert.deepEqual(invoked, [["--version"]]);
  } finally {
    fake.restore();
  }
});

test("canary not run reports canaryOk:false", async () => {
  const fake = await installFakeCli({ version: PINNED_CLI_VERSION });
  try {
    const h = await adapterCheck();
    assert.equal(h.cliVersion, PINNED_CLI_VERSION);
    assert.equal(h.canary, "not_run");
    assert.equal(h.canaryOk, false);
    assert.equal(h.canaryHash, undefined);
  } finally {
    fake.restore();
  }
});

test("canary runs info with read roots and hashes its output", async () => {
  const fakeInfo = { nodes: 3, pages: [{ frames: [] }], name: "canary" };
  const fake = await installFakeCli({ version: PINNED_CLI_VERSION, info: fakeInfo });
  try {
    const dir = await tempDir("tasteful-canary-");
    const canary = path.join(dir, "canary.figcraft");
    await fs.writeFile(canary, "not-a-real-document", "utf8");
    const h = await adapterCheck(undefined, { canary });
    assert.equal(h.canaryOk, true);
    assert.equal(h.canary, "ok");
    assert.equal(h.canaryHash, sha256Hex(JSON.stringify(fakeInfo) + "\n"));
    const invoked = await calls(fake.log);
    const infoArgv = invoked.find((a) => a[0] === "info");
    assert.ok(infoArgv, "canary info must run");
    assert.ok(infoArgv.includes("--automation-read-root"), "canary info must carry read roots");
    assert.ok(infoArgv.includes(dir), `read root ${dir} missing from ${infoArgv.join(" ")}`);
    assert.ok(!infoArgv.includes("--automation-write-root"), "reads must not carry a write root");
  } finally {
    fake.restore();
  }
});

test("pinned pair is cached per process and keyed by executable", async () => {
  const fake = await installFakeCli({ version: PINNED_CLI_VERSION });
  try {
    const first = await requirePinnedPair();
    const second = await requirePinnedPair();
    assert.equal(first.commandsHash, second.commandsHash);
    assert.equal(first.exePath, second.exePath);
    const invoked = await calls(fake.log);
    assert.equal(invoked.filter((a) => a[0] === "--version").length, 1, "version checked once");
    assert.equal(invoked.filter((a) => a[0] === "commands").length, 1, "commands hashed once");
  } finally {
    fake.restore();
  }
});

test("reset clears the cached pair", async () => {
  const fake = await installFakeCli({ version: PINNED_CLI_VERSION });
  try {
    await requirePinnedPair();
    resetAdapterHandshakeCache();
    await requirePinnedPair();
    const invoked = await calls(fake.log);
    assert.equal(invoked.filter((a) => a[0] === "--version").length, 2);
  } finally {
    fake.restore();
  }
});
