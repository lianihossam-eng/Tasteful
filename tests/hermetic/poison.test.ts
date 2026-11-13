/**
 * Hermetic poison tests: poisoned ~/.pi, ~/.agents, project .pi (extensions,
 * settings, APPEND_SYSTEM.md, SYSTEM.md), .agents/skills, AGENTS.md, CLAUDE.md,
 * PI_*, AI_AGENT=pi must have zero behavioral effect on the real loader,
 * the real session, and the CLI.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cmdStatus, cmdInit } from "../../src/cli/commands.js";
import { childEnv, isScrubbedEnvKey, scrubProcessEnv } from "../../src/host/env.js";
import { agentDir, agentSessionsDir } from "../../src/host/paths.js";
import { createProductLoader } from "../../src/host/product-loader.js";
import { PRODUCT_TOOL_NAMES } from "../../src/host/tools.js";
import { assembleSession } from "../../src/host/session.js";
import { tempDir } from "../helpers.js";

const MARKER = "POISON-MARKER-9f31";
const EXT_GLOBAL = "__TASTEFUL_POISON_EXTENSION__";

async function poisonExtension(file: string, markerFile: string, tag: string): Promise<void> {
  const body = `${JSON.stringify(tag)};`;
  const code =
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(tag)});\n` +
    `globalThis[${JSON.stringify(EXT_GLOBAL)}] = ${body}\n`;
  await fs.writeFile(file, code, "utf8");
}

async function poisonedHome(): Promise<{ home: string; project: string; extMarker: string }> {
  const home = await tempDir("tasteful-poison-home-");
  const project = await tempDir("tasteful-poison-proj-");
  const extMarker = path.join(project, "EVIL-EXTENSION-LOADED");
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ marker: MARKER }), "utf8");
  await fs.mkdir(path.join(home, ".agents", "skills", "evil"), { recursive: true });
  await fs.writeFile(path.join(home, ".agents", "skills", "evil", "SKILL.md"), `---\nname: evil\ndescription: ${MARKER}\n---\n${MARKER}`, "utf8");
  await fs.writeFile(path.join(home, ".agents", "x.md"), MARKER, "utf8");
  await fs.writeFile(path.join(home, "AGENTS.md"), MARKER, "utf8");
  await fs.writeFile(path.join(home, "CLAUDE.md"), MARKER, "utf8");
  await fs.writeFile(path.join(project, "AGENTS.md"), MARKER, "utf8");
  await fs.writeFile(path.join(project, "CLAUDE.md"), MARKER, "utf8");

  // Project .pi: discovered extensions would write a marker + a global.
  await fs.mkdir(path.join(project, ".pi", "extensions"), { recursive: true });
  await poisonExtension(path.join(project, ".pi", "extensions", "evil.js"), extMarker, "evil-js");
  await poisonExtension(path.join(project, ".pi", "extensions", "evil.ts"), extMarker, "evil-ts");
  await fs.writeFile(path.join(project, ".pi", "y.md"), MARKER, "utf8");
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
  await fs.writeFile(path.join(project, ".pi", "APPEND_SYSTEM.md"), MARKER, "utf8");
  await fs.writeFile(path.join(project, ".pi", "SYSTEM.md"), MARKER, "utf8");
  await fs.mkdir(path.join(project, ".agents", "skills", "evil"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".agents", "skills", "evil", "SKILL.md"),
    `---\nname: evil\ndescription: ${MARKER}\n---\n${MARKER}`,
    "utf8",
  );
  return { home, project, extMarker };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Run fn with TASTEFUL_HOME pointed at `home`. */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prev;
  }
}

test("poisoned context files never enter loader output", async () => {
  const { project, extMarker } = await poisonedHome();
  await withHome(await tempDir("tasteful-h-"), async () => {
    const loader = createProductLoader(project, {
      projectRoot: project,
      journal: { tastefulVersion: "0.1.0", piVersion: "1.5.2" },
    });
    await loader.reload();
    assert.ok(!JSON.stringify(loader.getAgentsFiles()).includes(MARKER));
    assert.ok(!(loader.getSystemPrompt() ?? "").includes(MARKER));
    assert.equal(loader.getSystemPromptSource(), undefined);
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.deepEqual(loader.getAppendSystemPromptSources(), []);
    assert.deepEqual(loader.getSkills().skills, []);
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(loader.getThemes().themes, []);
    // Only the product inline factory loads; .pi/extensions is never discovered.
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(loader.getExtensions().extensions[0]?.path, "<inline:tasteful-tools>");
    assert.equal(await exists(extMarker), false);
    assert.equal((globalThis as Record<string, unknown>)[EXT_GLOBAL], undefined);
  });
});

test("real session over poisoned project: no extension, no settings, 12 tools, clean system prompt", async () => {
  const { project, extMarker } = await poisonedHome();
  await withHome(await tempDir("tasteful-h-"), async () => {
    const handles = await assembleSession({
      projectRoot: project,
      journal: { tastefulVersion: "0.1.0", piVersion: "1.5.2" },
      model: "mock",
      mockSteps: [{ text: "poison check complete" }],
      inMemorySession: true,
    });
    try {
      assert.deepEqual(handles.session.getActiveToolNames().sort(), [...PRODUCT_TOOL_NAMES].sort());
      assert.equal(handles.session.getActiveToolNames().length, 12);
      // In-memory settings win: project .pi/settings.json is never read.
      assert.equal(handles.session.settingsManager.getEnableInstallTelemetry(), false);
      assert.equal(handles.session.settingsManager.getDefaultTools(), undefined);
      assert.ok(!handles.session.systemPrompt.includes(MARKER));
      assert.ok(!JSON.stringify(handles.session.settingsManager.getSettings()).includes(MARKER));
      await handles.session.prompt("Check the project.");
      assert.equal(await exists(extMarker), false);
      assert.equal((globalThis as Record<string, unknown>)[EXT_GLOBAL], undefined);
      assert.ok(!handles.session.systemPrompt.includes(MARKER));
    } finally {
      handles.dispose();
    }
  });
});

test("CLI runs with poisoned env + home; state lands under ~/.tasteful only", async () => {
  const { home, project } = await poisonedHome();
  const prevHome = process.env.TASTEFUL_HOME;
  const prevPi = process.env.PI_CODING_AGENT_DIR;
  const prevAgent = process.env.AI_AGENT;
  process.env.TASTEFUL_HOME = home;
  process.env.PI_CODING_AGENT_DIR = "/tmp/should-be-ignored";
  process.env.AI_AGENT = "pi";
  try {
    scrubProcessEnv();
    assert.equal(process.env.AI_AGENT, undefined);
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
    await cmdInit({ project }, "poison");
    const status = await cmdStatus({ project }, true);
    assert.ok(!status.includes(MARKER));
    // agent paths resolve under the temp TASTEFUL_HOME
    assert.ok(agentDir().startsWith(home));
    assert.ok(agentSessionsDir().startsWith(home));
    // poison files untouched
    assert.equal(await fs.readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8"), JSON.stringify({ marker: MARKER }));
  } finally {
    if (prevHome === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevHome;
    if (prevPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevPi;
    if (prevAgent === undefined) delete process.env.AI_AGENT;
    else process.env.AI_AGENT = prevAgent;
  }
});

test("spawned CLI with poisoned env: init/status succeed, marker never leaks", async () => {
  const { home, project } = await poisonedHome();
  const cli = path.resolve(import.meta.dirname, "../../src/bin.js");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      env: {
        ...process.env,
        TASTEFUL_HOME: home,
        PI_CUSTOM_LEAK_VALUE: MARKER,
        AI_AGENT: "pi",
        FIGCRAFT_CONTROL_PORT: "47823",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    return r;
  };
  const init = run(["init", "--project", project, "--name", "poison"]);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  assert.ok(!init.stdout.includes(MARKER));
  assert.ok(!init.stderr.includes(MARKER));
  const status = run(["status", "--project", project, "--json"]);
  assert.equal(status.status, 0, `status failed: ${status.stderr}`);
  assert.ok(!status.stdout.includes(MARKER));
  const parsed = JSON.parse(status.stdout) as { journal_ok: boolean };
  assert.equal(typeof parsed.journal_ok, "boolean");
});

test("env scrub rule is prefix-based: all PI_*, AI_AGENT, foreign control ports", () => {
  for (const key of [
    "PI_TELEMETRY",
    "PI_CUSTOM_LEAK_VALUE",
    "PI_PACKAGE_DIR",
    "PI_ANYTHING_NEW",
    "AI_AGENT",
    "FIGCRAFT_CONTROL_PORT",
    "VECTORCRAFT_CONTROL_PORT",
    "SOMECRAFT_CONTROL_PORT",
  ]) {
    assert.equal(isScrubbedEnvKey(key), true, `${key} should be scrubbed`);
  }
  for (const key of ["TASTEFUL_HOME", "TASTEFUL_KEEP", "TASTEFUL_CONTROL_PORT", "PATH", "HOME"]) {
    assert.equal(isScrubbedEnvKey(key), false, `${key} should pass`);
  }

  process.env.PI_TEST_LEAK = "1";
  process.env.AI_AGENT = "pi";
  process.env.NEWCRAFT_CONTROL_PORT = "1234";
  process.env.TASTEFUL_KEEP = "yes";
  const env = childEnv();
  assert.equal(env.PI_TEST_LEAK, undefined);
  assert.equal(env.AI_AGENT, undefined);
  assert.equal(env.NEWCRAFT_CONTROL_PORT, undefined);
  assert.equal(env.TASTEFUL_KEEP, "yes");
  const withExtras = childEnv({ PI_EXTRA: "1", AI_AGENT: "pi", TASTEFUL_EXTRA: "1" });
  assert.equal(withExtras.PI_EXTRA, undefined);
  assert.equal(withExtras.AI_AGENT, undefined);
  assert.equal(withExtras.TASTEFUL_EXTRA, "1");
  delete process.env.PI_TEST_LEAK;
  delete process.env.AI_AGENT;
  delete process.env.NEWCRAFT_CONTROL_PORT;
  delete process.env.TASTEFUL_KEEP;
});

test("our src never imports pi discovery helpers", async () => {
  // Compiled tests live in dist/tests/hermetic; audit the TypeScript sources.
  const src = path.resolve(import.meta.dirname, "../../../src");
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(f)));
      else if (e.name.endsWith(".ts")) out.push(f);
    }
    return out;
  }
  const banned = [
    "getAgentDir",
    "CONFIG_DIR_NAME",
    "DefaultPackageManager",
    "DefaultResourceLoader",
    "createMcpExtension",
    "getClientIdentity",
    "PI_ATTRIBUTION",
  ];
  const files = await walk(src);
  assert.ok(files.length > 0, `import audit found no sources under ${src}`);
  for (const f of files) {
    const text = await fs.readFile(f, "utf8");
    // Static import/export clauses: only imported names and module specifiers
    // count; comments and locally defined identifiers are not imports.
    const importRe = /\b(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
    for (const match of text.matchAll(importRe)) {
      const clause = match[1] ?? "";
      const specifier = match[2] ?? "";
      for (const name of banned) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(clause), `${f} imports ${name}`);
      }
      assert.ok(
        !specifier.startsWith("@earendil-works/pi-coding-agent/"),
        `${f} deep-imports the pi package: ${specifier}`,
      );
    }
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = match[1] ?? "";
      for (const name of banned) {
        assert.ok(!specifier.includes(name), `${f} dynamically imports ${name}`);
      }
      assert.ok(
        !specifier.startsWith("@earendil-works/pi-coding-agent/"),
        `${f} deep-imports the pi package: ${specifier}`,
      );
    }
  }
});
