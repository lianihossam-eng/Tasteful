/**
 * Launcher tests: a set PI_PACKAGE_DIR, other PI_ variables, and AI_AGENT are
 * scrubbed before the SDK module graph is imported. The launcher is the real
 * compiled entry point (`dist/src/bin.js`, the package bin).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { TASTEFUL_VERSION } from "../../src/version.js";
import { tempDir } from "../helpers.js";

const BIN = path.resolve(import.meta.dirname, "../../src/bin.js");
const CLI_MODULE = path.resolve(import.meta.dirname, "../../src/cli.js");
const ROOT = path.resolve(import.meta.dirname, "../../..");
const MARKER = "LAUNCHER-POISON-MARKER-7aa2";

interface LauncherResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLauncher(args: string[], env: NodeJS.ProcessEnv): LauncherResult {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000, env });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Clean base env: no ambient PI_* from the test runner or operator shell. */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === undefined || key.startsWith("PI_")) continue;
    if (key === "AI_AGENT") continue;
    env[key] = value;
  }
  env.HOME = home;
  env.TASTEFUL_HOME = home;
  return env;
}

async function fakePackage(markerFile: string): Promise<string> {
  const pkg = await tempDir("tasteful-fake-pi-package-");
  await fs.writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "evil-pi", version: "9.9.9", piConfig: { configDir: ".evil" } }),
    "utf8",
  );
  await fs.mkdir(path.join(pkg, ".evil", "extensions"), { recursive: true });
  await fs.writeFile(
    path.join(pkg, ".evil", "extensions", "evil.js"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerFile)}, "evil");\n`,
    "utf8",
  );
  await fs.writeFile(path.join(pkg, ".evil", "settings.json"), JSON.stringify({ marker: MARKER }), "utf8");
  return pkg;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("package bin resolves to the env-first launcher", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  assert.equal(pkg.bin.tasteful, "./dist/src/bin.js");
});

test("PI_PACKAGE_DIR is scrubbed before import: version works, diagnostic printed, no .evil discovery", async () => {
  const home = await tempDir("tasteful-launcher-home-");
  const markerFile = path.join(home, "EVIL-LAUNCHER-EXTENSION");
  const fake = await fakePackage(markerFile);
  const env = baseEnv(home);
  env.PI_PACKAGE_DIR = fake;

  const res = runLauncher(["--version"], env);
  assert.equal(res.status, 0, `launcher failed: ${res.stderr}`);
  assert.equal(res.stdout, `tasteful ${TASTEFUL_VERSION}\n`);
  assert.ok(
    res.stderr.includes(`TASTEFUL: ignoring PI_PACKAGE_DIR=${fake}\n`),
    `missing diagnostic, stderr=${JSON.stringify(res.stderr)}`,
  );
  assert.ok(!res.stderr.includes(MARKER), "fake package settings leaked to stderr");
  assert.equal(await exists(markerFile), false, "fake package .evil extension executed");
});

test("launcher without PI_PACKAGE_DIR prints no diagnostic", async () => {
  const home = await tempDir("tasteful-launcher-clean-home-");
  const res = runLauncher(["--version"], baseEnv(home));
  assert.equal(res.status, 0, `launcher failed: ${res.stderr}`);
  assert.equal(res.stdout, `tasteful ${TASTEFUL_VERSION}\n`);
  assert.ok(!res.stderr.includes("PI_PACKAGE_DIR"), `unexpected diagnostic: ${res.stderr}`);
});

test("importing cli.js has no side effects; the launcher drives it", async () => {
  const script = `await import(${JSON.stringify(pathToFileURL(CLI_MODULE).href)});`;
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 120_000,
    env: baseEnv(await tempDir("tasteful-launcher-import-home-")),
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "", "importing cli.js must not execute the CLI");
  assert.equal(imported.stderr, "", "importing cli.js must not write errors");

  const home = await tempDir("tasteful-launcher-error-home-");
  const failed = runLauncher(["--project", home, "bogus-command"], baseEnv(home));
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /^E_USAGE: /);
  assert.equal(failed.stdout, "");
});
