/**
 * Zero-discovery proof by syscall trace. The real launcher is run under
 * strace with a poisoned project (.pi/extensions, .pi/settings.json,
 * SYSTEM.md/APPEND_SYSTEM.md, .agents/skills, AGENTS.md/CLAUDE.md) and a
 * poisoned temp HOME (~/.pi, ~/.agents, AGENTS.md, CLAUDE.md), plus a fake
 * PI_PACKAGE_DIR package. Both the pure status path and the real session path
 * (`run --model mock`) must not open or stat `.pi/` or `.agents/` anywhere.
 *
 * The strace assertion is fail-before: the previous DefaultResourceLoader
 * configuration stats `~/.agents/skills` (and project `.pi`) during reload.
 * Skips with an explicit reason when strace is not installed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tempDir } from "../helpers.js";

const MARKER = "STRACE-POISON-MARKER-c41d";
const EXT_GLOBAL = "__TASTEFUL_STRACE_POISON__";
const BIN = path.resolve(import.meta.dirname, "../../src/bin.js");

const STRACE_CHECK = spawnSync("strace", ["-V"], { encoding: "utf8" });
const STRACE = !STRACE_CHECK.error && STRACE_CHECK.status === 0;
const SKIP_REASON = STRACE ? false : "strace not installed";

interface Poison {
  home: string;
  project: string;
  markerFile: string;
  fakePkg: string;
}

async function writeEvilExtension(file: string, markerFile: string, tag: string): Promise<void> {
  const code =
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(tag)});\n` +
    `globalThis[${JSON.stringify(EXT_GLOBAL)}] = ${JSON.stringify(tag)};\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, code, "utf8");
}

async function poisonedFixture(): Promise<Poison> {
  const home = await tempDir("tasteful-strace-home-");
  const project = path.join(home, "project");
  const markerFile = path.join(home, "EVIL-EXTENSION-LOADED");
  const fakePkg = path.join(home, "evil-pi-package");
  await fs.mkdir(project, { recursive: true });

  // Ambient HOME poison.
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ marker: MARKER }), "utf8");
  await fs.mkdir(path.join(home, ".agents", "skills", "evil"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".agents", "skills", "evil", "SKILL.md"),
    `---\nname: evil\ndescription: ${MARKER}\n---\n${MARKER}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(home, "AGENTS.md"), MARKER, "utf8");
  await fs.writeFile(path.join(home, "CLAUDE.md"), MARKER, "utf8");

  // Project poison: discovery must never reach any of these.
  await writeEvilExtension(path.join(project, ".pi", "extensions", "evil.js"), markerFile, "evil-js");
  await writeEvilExtension(path.join(project, ".pi", "extensions", "evil.ts"), markerFile, "evil-ts");
  await fs.writeFile(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({
      marker: MARKER,
      defaultTools: ["read", "bash", "edit", "write"],
      extensionPaths: [".pi/extensions/evil.js"],
      packages: ["npm:evil"],
      enableInstallTelemetry: true,
    }),
    "utf8",
  );
  await fs.writeFile(path.join(project, ".pi", "SYSTEM.md"), MARKER, "utf8");
  await fs.writeFile(path.join(project, ".pi", "APPEND_SYSTEM.md"), MARKER, "utf8");
  await fs.mkdir(path.join(project, ".agents", "skills", "evil"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".agents", "skills", "evil", "SKILL.md"),
    `---\nname: evil\ndescription: ${MARKER}\n---\n${MARKER}\n`,
    "utf8",
  );
  for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"]) {
    await fs.writeFile(path.join(project, name), MARKER, "utf8");
  }

  // A set PI_PACKAGE_DIR must be scrubbed before the SDK import: its config
  // dir must never be discovered either.
  await fs.mkdir(path.join(fakePkg, ".evil", "extensions"), { recursive: true });
  await fs.writeFile(
    path.join(fakePkg, "package.json"),
    JSON.stringify({ name: "evil-pi", version: "9.9.9", piConfig: { configDir: ".evil" } }),
    "utf8",
  );
  await writeEvilExtension(path.join(fakePkg, ".evil", "extensions", "evil.js"), markerFile, "evil-package");
  await fs.writeFile(path.join(fakePkg, ".evil", "settings.json"), JSON.stringify({ marker: MARKER }), "utf8");

  return { home, project, markerFile, fakePkg };
}

interface TracedRun {
  status: number | null;
  stdout: string;
  stderr: string;
  trace: string;
}

function runUnderStrace(poison: Poison, args: string[], traceName: string): TracedRun {
  const traceFile = path.join(poison.home, `${traceName}.strace`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: poison.home,
    TASTEFUL_HOME: poison.home,
    PI_PACKAGE_DIR: poison.fakePkg,
    PI_CODING_AGENT_DIR: path.join(poison.home, ".pi", "agent"),
    PI_CUSTOM_LEAK_VALUE: MARKER,
    AI_AGENT: "pi",
    FIGCRAFT_CONTROL_PORT: "47823",
  };
  const res = spawnSync(
    "strace",
    ["-f", "-qq", "-e", "trace=%file", "-o", traceFile, process.execPath, BIN, "--project", poison.project, ...args],
    { cwd: poison.project, env, encoding: "utf8", timeout: 240_000 },
  );
  if (res.error) throw res.error;
  const trace = readFileSync(traceFile, "utf8");
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    trace,
  };
}

function discoveryLines(trace: string, forbidden: string[]): string[] {
  return trace
    .split("\n")
    .filter((line) => {
      if (forbidden.some((p) => p.length > 0 && line.includes(p))) return true;
      for (const dir of ["/.pi/", "/.agents/", "/.evil/", '".pi/', '".agents/', '".evil/']) {
        if (line.includes(dir)) return true;
      }
      return false;
    })
    .filter((line) => line.length > 0);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("status and session paths never open/stat .pi, .agents, or PI_PACKAGE_DIR state", { skip: SKIP_REASON }, async () => {
  const poison = await poisonedFixture();
  const init = spawnSync(process.execPath, [BIN, "--project", poison.project, "init", "--name", "strace"], {
    cwd: poison.project,
    env: { ...process.env, HOME: poison.home, TASTEFUL_HOME: poison.home },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);

  const status = runUnderStrace(poison, ["status", "--json"], "status");
  assert.equal(status.status, 0, `status failed: ${status.stderr}`);
  assert.ok(status.trace.includes("bin.js"), "strace captured no launcher file syscalls");
  const parsed = JSON.parse(status.stdout) as { journal_ok: boolean };
  assert.equal(typeof parsed.journal_ok, "boolean");
  assert.deepEqual(discoveryLines(status.trace, [poison.fakePkg]), [], "status path opened/statted ambient discovery paths");

  const session = runUnderStrace(poison, ["run", "--prompt", "trace session", "--model", "mock"], "session");
  assert.equal(session.status, 0, `session run failed: ${session.stderr}`);
  assert.match(session.stdout, /tools: run_journal_read/);
  assert.deepEqual(discoveryLines(session.trace, [poison.fakePkg]), [], "session path opened/statted ambient discovery paths");

  for (const run of [status, session]) {
    assert.ok(!run.stdout.includes(MARKER), "poison marker leaked to stdout");
    assert.ok(!run.stderr.includes(MARKER), "poison marker leaked to stderr");
  }
  assert.equal(await exists(poison.markerFile), false, "poison extension executed");
  assert.equal((globalThis as Record<string, unknown>)[EXT_GLOBAL], undefined, "poison extension mutated the process");
});
