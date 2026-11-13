import { rejectsWithCode } from "../assert-code.js";
/** CLI approve --grant/--deny round-trip against the real dist CLI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeCtx } from "../../src/cli/commands.js";
import { fsWrite, resolveProjectPath } from "../../src/host/tools.js";
import { tempDir } from "../helpers.js";

const CLI = fileURLToPath(new URL("../../src/bin.js", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("approve --grant/--deny CLI round-trip with agent fs_write", { timeout: 120000 }, async () => {
  const project = await tempDir("tasteful-approve-cli-");
  const home = await tempDir("tasteful-approve-home-");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TASTEFUL_HOME: home };
  const cli = (args: string[]) => runCli(["--project", project, ...args], env);

  const init = await cli(["init", "--name", "approve-cli"]);
  assert.equal(init.code, 0, init.stderr);

  const tc = makeCtx(project, "agent");
  const target = await resolveProjectPath(tc, "notes.txt");
  const paramsJson = JSON.stringify({ path: "notes.txt" });

  const grant = await cli([
    "approve", "--grant", "--tool", "fs_write", "--target", target,
    "--content", "hello", "--params-json", paramsJson, "--approver", "op@tasteful",
  ]);
  assert.equal(grant.code, 0, grant.stderr);
  const digest = grant.stdout.trim();
  assert.match(digest, /^[0-9a-f]{64}$/);

  const pending = await cli(["approve", "--list"]);
  assert.equal(pending.code, 0, pending.stderr);
  assert.match(pending.stdout, new RegExp(digest.slice(0, 16)));

  await fsWrite(tc, { path: "notes.txt", content: "hello" });
  await rejectsWithCode(fsWrite(tc, { path: "notes.txt", content: "hello" }), "E_APPROVAL_REPLAY");

  const target2 = await resolveProjectPath(tc, "notes2.txt");
  const deny = await cli([
    "approve", "--deny", "--tool", "fs_write", "--target", target2,
    "--content", "hello", "--params-json", JSON.stringify({ path: "notes2.txt" }), "--approver", "op@tasteful",
  ]);
  assert.equal(deny.code, 0, deny.stderr);
  assert.match(deny.stdout.trim(), /^[0-9a-f]{64}$/);
  await rejectsWithCode(fsWrite(tc, { path: "notes2.txt", content: "hello" }), "E_APPROVAL_DENIED");

  const empty = await cli(["approve", "--list"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /no pending approvals/);

  const usage = await cli(["approve", "--grant", "--tool", "fs_write"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /E_USAGE/);

  const badJson = await cli([
    "approve", "--grant", "--tool", "fs_write", "--target", target,
    "--content", "hello", "--params-json", "{not json",
  ]);
  assert.equal(badJson.code, 2);
  assert.match(badJson.stderr, /E_USAGE/);
});
