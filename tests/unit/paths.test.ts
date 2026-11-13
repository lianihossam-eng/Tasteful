import { rejectsWithCode } from "../assert-code.js";
/** Path escapes: absolute, .., symlink, /proc, ~/.pi — reads and writes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initProject } from "../../src/design/store.js";
import { sha256Hex } from "../../src/design/hashes.js";
import { cmdExport, makeCtx } from "../../src/cli/commands.js";
import { FS_READ_MAX_FILE_BYTES, decisionGet, fsList, fsRead, fsWrite, gateGet, decisionUpsert, resolveProjectPath } from "../../src/host/tools.js";
import { grantApproval } from "../../src/host/approvals.js";
import { decisionBase, tempDir, withTempHome, writeJson } from "../helpers.js";

async function setup() {
  const home = await tempDir("tasteful-home-");
  process.env.TASTEFUL_HOME = home;
  const dir = await tempDir("tasteful-paths-");
  await initProject(dir, "paths", "0.1.0");
  await fs.writeFile(path.join(dir, "ok.txt"), "hello", "utf8");
  return { dir, home };
}

test("in-roots read works", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  const res = await fsRead(tc, { path: "ok.txt" });
  assert.equal(res.content, "hello");
});

test("absolute path outside roots rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await rejectsWithCode(resolveProjectPath(tc, "/etc/hostname", { mustExist: true }), "E_PATH_ESCAPE");
});

test(".. escape rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await rejectsWithCode(resolveProjectPath(tc, "../outside.txt"), "E_PATH_ESCAPE");
});

test("symlink escaping roots rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  const outside = await tempDir("tasteful-outside-");
  await fs.writeFile(path.join(outside, "secret.txt"), "s", "utf8");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
  await rejectsWithCode(fsRead(tc, { path: "link.txt" }), "E_PATH_ESCAPE");
});

test("symlink inside roots allowed", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await fs.symlink(path.join(dir, "ok.txt"), path.join(dir, "inner.txt"));
  const res = await fsRead(tc, { path: "inner.txt" });
  assert.equal(res.content, "hello");
});

test("/proc/self/fd rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await rejectsWithCode(resolveProjectPath(tc, "/proc/self/fd/1"), "E_PATH_ESCAPE");
});

test("~/.pi rejected even if HOME set", async () => {
  await withTempHome(async (home) => {
    const dir = await tempDir("tasteful-pihome-");
    await initProject(dir, "pihome", "0.1.0");
    const dotpi = path.join(home, ".pi");
    await fs.mkdir(dotpi, { recursive: true });
    await fs.writeFile(path.join(dotpi, "x.txt"), "x", "utf8");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const tc = makeCtx(dir);
      await rejectsWithCode(resolveProjectPath(tc, path.join(dotpi, "x.txt")), "E_PATH_ESCAPE");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

test("hardlinked read target rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await fs.link(path.join(dir, "ok.txt"), path.join(dir, "hard.txt"));
  await rejectsWithCode(fsRead(tc, { path: "hard.txt" }), "E_PATH_HARDLINK");
  await rejectsWithCode(resolveProjectPath(tc, "hard.txt", { mustExist: true }), "E_PATH_HARDLINK");
});

test("symlinked .tasteful root rejected at init", async () => {
  const dir = await tempDir("tasteful-symlink-");
  const outside = await tempDir("tasteful-outside-");
  await fs.symlink(outside, path.join(dir, ".tasteful"));
  await rejectsWithCode(initProject(dir, "s", "0.1.0"), "E_PATH_SYMLINK");
  assert.deepEqual(await fs.readdir(outside), []);
});

test("symlinked state subdir rejected at init", async () => {
  const dir = await tempDir("tasteful-symlink-");
  await initProject(dir, "s", "0.1.0");
  const outside = await tempDir("tasteful-outside-");
  await fs.rm(path.join(dir, ".tasteful", "decisions"), { recursive: true, force: true });
  await fs.symlink(outside, path.join(dir, ".tasteful", "decisions"));
  await rejectsWithCode(initProject(dir, "s", "0.1.0"), "E_PATH_SYMLINK");
});

test("reserved project state writes denied even with approval", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  const rel = ".tasteful/decisions/evil.json";
  const target = await resolveProjectPath(tc, rel);
  await grantApproval(tc.project, {
    tool: "fs_write",
    target,
    content: "{}",
    params: { path: rel },
    approver: "op@tasteful",
  });
  await rejectsWithCode(fsWrite(tc, { path: rel, content: "{}" }), "E_PATH_RESERVED");
  for (const reserved of [
    ".tasteful/journal/run.jsonl",
    ".tasteful/approvals/forged.json",
    ".tasteful/events/forged.json",
    ".tasteful/gates/G-FORGED.json",
    ".tasteful/validations/forged.json",
    ".tasteful/.lock",
  ]) {
    await rejectsWithCode(fsWrite(tc, { path: reserved, content: "x" }), "E_PATH_RESERVED");
  }
});

test("decision_get and gate_get reject traversal ids", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await rejectsWithCode(decisionGet(tc, { id: "../../etc/passwd" }), "E_PATH");
  await rejectsWithCode(decisionGet(tc, { id: "D001/../../x" }), "E_PATH");
  await rejectsWithCode(gateGet(tc, { gate_id: "../../G-X" }), "E_PATH");
  await rejectsWithCode(gateGet(tc, { gate_id: "G-../../x" }), "E_PATH");
});

test("tampered decision hash rejected on read", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await decisionUpsert(tc, { decision: decisionBase("D001") });
  const file = path.join(dir, ".tasteful", "decisions", "D001.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  stored.title = "tampered";
  await writeJson(file, stored);
  await rejectsWithCode(decisionGet(tc, { id: "D001" }), "E_HASH_MISMATCH");
});

test("hardlinked write target rejected", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await fs.link(path.join(dir, "ok.txt"), path.join(dir, "hard-write.txt"));
  const target = await resolveProjectPath(tc, "hard-write.txt");
  await grantApproval(tc.project, {
    tool: "fs_write",
    target,
    content: "new",
    params: { path: "hard-write.txt" },
    approver: "op@tasteful",
  });
  await rejectsWithCode(fsWrite(tc, { path: "hard-write.txt", content: "new" }), "E_PATH_HARDLINK");
  assert.equal(await fs.readFile(path.join(dir, "ok.txt"), "utf8"), "hello");
  assert.equal(await fs.readFile(path.join(dir, "hard-write.txt"), "utf8"), "hello");
  // The hardlink check runs before approval consumption: once the link is
  // removed the same grant still authorizes the write.
  await fs.rm(path.join(dir, "hard-write.txt"));
  const res = await fsWrite(tc, { path: "hard-write.txt", content: "new" });
  assert.equal(res.sha256, sha256Hex("new"));
  assert.equal(await fs.readFile(path.join(dir, "hard-write.txt"), "utf8"), "new");
});

test("truncated read returns the full-file sha256", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  await fs.writeFile(path.join(dir, "data.txt"), "abcdefghij", "utf8");
  const res = await fsRead(tc, { path: "data.txt", max_bytes: 4 });
  assert.equal(res.content, "abcd");
  assert.equal(res.truncated, true);
  assert.equal(res.sha256, sha256Hex("abcdefghij"));
});

test("fs_read rejects files above the full-hash cap", async () => {
  const { dir } = await setup();
  const tc = makeCtx(dir);
  const file = path.join(dir, "huge.bin");
  await fs.writeFile(file, "", "utf8");
  await fs.truncate(file, FS_READ_MAX_FILE_BYTES + 1);
  await rejectsWithCode(fsRead(tc, { path: "huge.bin" }), "E_PATH_TOO_LARGE");
});

test("agent state in a home project is denied to fs tools", async () => {
  const prevHome = process.env.HOME;
  const prevTasteful = process.env.TASTEFUL_HOME;
  const home = await tempDir("tasteful-homeproj-");
  process.env.HOME = home;
  process.env.TASTEFUL_HOME = home;
  try {
    await initProject(home, "homeproj", "0.1.0");
    const secret = path.join(home, ".tasteful", "agent", "auth.json");
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.writeFile(secret, '{"apiKey":"TEST_ONLY_VALUE"}', "utf8");
    const tc = makeCtx(home);
    await rejectsWithCode(fsList(tc, { path: ".tasteful/agent" }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsRead(tc, { path: ".tasteful/agent/auth.json" }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsRead(tc, { path: secret }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsWrite(tc, { path: ".tasteful/agent/auth.json", content: "PWNED" }), "E_PATH_ESCAPE");
    assert.equal(await fs.readFile(secret, "utf8"), '{"apiKey":"TEST_ONLY_VALUE"}');
    // The rest of the project remains usable.
    await fs.writeFile(path.join(home, "notes.txt"), "ok", "utf8");
    assert.equal((await fsRead(tc, { path: "notes.txt" })).content, "ok");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevTasteful === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevTasteful;
  }
});

test("TASTEFUL_HOME equal to the project root still hides agent state", async () => {
  const prevHome = process.env.HOME;
  const prevTasteful = process.env.TASTEFUL_HOME;
  const project = await tempDir("tasteful-selfhome-");
  const home = await tempDir("tasteful-otherhome-");
  process.env.HOME = home;
  process.env.TASTEFUL_HOME = project;
  try {
    await initProject(project, "selfhome", "0.1.0");
    const secret = path.join(project, ".tasteful", "agent", "auth.json");
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.writeFile(secret, '{"apiKey":"TEST_ONLY_VALUE"}', "utf8");
    const tc = makeCtx(project);
    await rejectsWithCode(fsList(tc, { path: ".tasteful/agent" }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsRead(tc, { path: ".tasteful/agent/auth.json" }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsWrite(tc, { path: ".tasteful/agent/auth.json", content: "PWNED" }), "E_PATH_ESCAPE");
    assert.equal(await fs.readFile(secret, "utf8"), '{"apiKey":"TEST_ONLY_VALUE"}');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevTasteful === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevTasteful;
  }
});

test("agent state outside the project is denied by the allowlist", async () => {
  const prevTasteful = process.env.TASTEFUL_HOME;
  const home = await tempDir("tasteful-agenthome-");
  const project = await tempDir("tasteful-agentproj-");
  process.env.TASTEFUL_HOME = home;
  try {
    await initProject(project, "agentproj", "0.1.0");
    const secret = path.join(home, ".tasteful", "agent", "auth.json");
    const sibling = path.join(home, ".tasteful", "config.json");
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.writeFile(secret, '{"apiKey":"TEST_ONLY_VALUE"}', "utf8");
    await fs.writeFile(sibling, "{}", "utf8");
    const tc = makeCtx(project);
    await rejectsWithCode(fsRead(tc, { path: secret }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsRead(tc, { path: sibling }), "E_PATH_ESCAPE");
    await rejectsWithCode(fsWrite(tc, { path: secret, content: "PWNED" }), "E_PATH_ESCAPE");
  } finally {
    if (prevTasteful === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevTasteful;
  }
});

test("symlinked project root cannot write reserved state even with approval", async () => {
  const base = await tempDir("tasteful-symroot-");
  const real = path.join(base, "real");
  await fs.mkdir(real);
  const link = path.join(base, "link");
  await fs.symlink(real, link);
  await initProject(link, "symroot", "0.1.0");
  const tc = makeCtx(link, "agent");
  const reserved = [
    ".tasteful/decisions/evil.json",
    ".tasteful/journal/run.jsonl",
    ".tasteful/approvals/forged.json",
    ".tasteful/events/forged.json",
    ".tasteful/gates/G-FORGED.json",
    ".tasteful/validations/forged.json",
    ".tasteful/.lock",
  ];
  for (const rel of reserved) {
    const target = await resolveProjectPath(tc, rel);
    await grantApproval(tc.project, {
      tool: "fs_write",
      target,
      content: "PWNED",
      params: { path: rel },
      approver: "op@tasteful",
    });
    await rejectsWithCode(fsWrite(tc, { path: rel, content: "PWNED" }), "E_PATH_RESERVED");
  }
  for (const rel of reserved) {
    await assert.rejects(fs.stat(path.join(real, rel)), `reserved target created: ${rel}`);
  }

  // The symlinked project remains usable for ordinary files.
  const target = await resolveProjectPath(tc, "note.txt");
  await grantApproval(tc.project, {
    tool: "fs_write",
    target,
    content: "ok",
    params: { path: "note.txt" },
    approver: "op@tasteful",
  });
  await fsWrite(tc, { path: "note.txt", content: "ok" });
  assert.equal(await fs.readFile(path.join(real, "note.txt"), "utf8"), "ok");
});

test("export --out into reserved state via a symlinked project root is denied", async () => {
  const base = await tempDir("tasteful-symexport-");
  const real = path.join(base, "real");
  await fs.mkdir(real);
  const link = path.join(base, "link");
  await fs.symlink(real, link);
  await initProject(link, "symexport", "0.1.0");
  await fs.writeFile(path.join(real, "source.fig"), "not a figcraft file", "utf8");
  await rejectsWithCode(
    cmdExport(
      { project: link },
      { file: "source.fig", out: ".tasteful/gates/G-X.json" },
    ),
    "E_PATH_RESERVED",
  );
  await assert.rejects(fs.stat(path.join(real, ".tasteful", "gates", "G-X.json")));
});
