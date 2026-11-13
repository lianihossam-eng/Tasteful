/**
 * Contract tests: the five JSON contracts parse and are owned/versioned, a
 * minimal structural validator enforces each contract against known-good and
 * known-bad records, TS validators agree on decisions/events/gates/coverage,
 * the adapter argv matches adapter-matrix.md exactly, the product loader is
 * inline-only, and session assembly passes the exact documented options.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PI_PACKAGE_PATH, PI_VERSION, PRODUCT_PACKAGE_PATH, TASTEFUL_VERSION } from "../../src/version.js";
import { PRODUCT_TOOL_NAMES } from "../../src/host/tools.js";
import { assembleSession, type SessionHandles } from "../../src/host/session.js";
import { createProductLoader } from "../../src/host/product-loader.js";
import { TASTEFUL_SYSTEM_PROMPT, createProductSettingsManager } from "../../src/host/resources.js";
import { agentAuthPath, agentDir } from "../../src/host/paths.js";
import { appendJournal, verifyJournal } from "../../src/host/journal.js";
import { projectPaths } from "../../src/design/store.js";
import { isRecord, validateChangeEvent, validateCoverage, validateDecision, validateGate, validateStoredDecision } from "../../src/design/schema.js";
import { helpText } from "../../src/cli/identity.js";
import { buildExportArgv, buildInfoArgv } from "../../src/artcraft/figcraft.js";
import { decisionBase, tempDir } from "../helpers.js";
import { scenarioEvent } from "../fixtures/decisions.js";

const ROOT = path.dirname(PRODUCT_PACKAGE_PATH);
const CONTRACTS = path.join(ROOT, "docs", "contracts");
const CONTRACT_FILES = [
  "change-event-schema.json",
  "coverage-matrix-schema.json",
  "decision-schema.json",
  "gate-schema.json",
  "run-journal-schema.json",
];

test("all five JSON contracts parse with title, version, and owner", async () => {
  const actual = (await fs.readdir(CONTRACTS)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(actual, CONTRACT_FILES);
  for (const file of CONTRACT_FILES) {
    const raw = JSON.parse(await fs.readFile(path.join(CONTRACTS, file), "utf8")) as Record<string, unknown>;
    assert.equal(raw.$schema, "https://json-schema.org/draft/2020-12/schema", `${file}: $schema`);
    assert.ok(typeof raw.title === "string" && raw.title.length > 0, `${file}: title`);
    assert.equal(raw.version, 1, `${file}: version`);
    assert.ok(typeof raw.owner === "string" && raw.owner.length > 0, `${file}: owner`);
  }
});

test("product and pi versions match their package.json sources", async () => {
  const product = JSON.parse(await fs.readFile(PRODUCT_PACKAGE_PATH, "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
  };
  const pi = JSON.parse(await fs.readFile(PI_PACKAGE_PATH, "utf8")) as { name: string; version: string };
  assert.equal(TASTEFUL_VERSION, product.version);
  assert.equal(PI_VERSION, "1.5.2");
  assert.equal(pi.name, "@earendil-works/pi-coding-agent");
  assert.equal(PI_VERSION, pi.version);
  assert.equal(product.dependencies["@earendil-works/pi-coding-agent"], pi.version);
  assert.equal(product.dependencies["@earendil-works/pi-ai"], "1.5.2");
  assert.ok(product.dependencies.typebox, "typebox must be a declared direct dependency");
});

test("tool-manifest names equal PRODUCT_TOOL_NAMES", async () => {
  const manifest = await fs.readFile(path.join(CONTRACTS, "tool-manifest.md"), "utf8");
  const names = [...manifest.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map((m) => m[1]).sort();
  const expected = [...PRODUCT_TOOL_NAMES].sort();
  assert.equal(expected.length, 12, "PRODUCT_TOOL_NAMES must list exactly 12 tools");
  assert.deepEqual(names, expected);
});

test("session assembly: exact documented options, 12 tools, telemetry off", async () => {
  const projectRoot = await tempDir("tasteful-contract-project-");
  const home = await tempDir("tasteful-contract-home-");
  const prevHome = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = home;
  let handles: SessionHandles | undefined;
  try {
    handles = await assembleSession({
      projectRoot,
      journal: { tastefulVersion: TASTEFUL_VERSION, piVersion: PI_VERSION },
      model: "mock",
      inMemorySession: true,
    });
    const opts = handles.sessionOptions;
    assert.equal(opts.agentDir, agentDir(), "agentDir must be $TASTEFUL_HOME/.tasteful/agent");
    assert.equal(opts.agentDir, path.join(home, ".tasteful", "agent"));
    assert.equal(opts.resourceLoader.constructor.name, "ProductResourceLoader");
    assert.equal(handles.session.resourceLoader.constructor.name, "ProductResourceLoader");
    assert.equal(opts.settingsManager, handles.session.settingsManager, "the explicit settings instance must be used");
    assert.equal(opts.settingsManager.getEnableInstallTelemetry(), false);
    assert.equal(opts.settingsManager.getCompactionEnabled(), false);
    assert.equal(opts.settingsManager.getRetryEnabled(), false);
    assert.deepEqual(opts.tools, [...PRODUCT_TOOL_NAMES], "tools allowlist must be exactly the product tools");
    assert.deepEqual(handles.session.getActiveToolNames().sort(), [...PRODUCT_TOOL_NAMES].sort());
    assert.equal(handles.session.getActiveToolNames().length, 12);
    assert.equal(opts.cwd, projectRoot, "cwd must be the project root");
    assert.equal(handles.session.sessionManager.getCwd(), projectRoot);
    assert.equal(opts.sessionManagerKind, "in-memory");
    assert.equal(handles.session.sessionManager.isPersisted(), false);
    assert.equal(opts.modelRuntimeAuthPath, agentAuthPath());
    assert.equal(opts.modelRuntimeAuthPath, path.join(home, ".tasteful", "agent", "auth.json"));
    assert.equal(handles.session.modelRuntime.constructor.name, "ModelRuntime");
    assert.equal(handles.session.model?.id, opts.modelId);
    assert.ok(opts.modelId.length > 0, "model id must be recorded");
    assert.deepEqual(opts.customToolNames.slice().sort(), [...PRODUCT_TOOL_NAMES].sort());
    assert.equal(opts.thinkingLevel, "off");
    assert.equal(handles.session.thinkingLevel, "off");
  } finally {
    handles?.dispose();
    if (prevHome === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevHome;
  }
});

// ---------------------------------------------------------------------------
// Minimal structural validator for the JSON Schema subset used by the five
// contracts (no new dependency). It is intentionally strict: unknown fields,
// enums, patterns, required keys, and nested items are enforced.

interface SchemaNode {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case "object": return isRecord(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: throw new Error(`unsupported schema type '${type}'`);
  }
}

function assertSchema(schema: SchemaNode, value: unknown, at = "$"): void {
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${at}: const mismatch`);
  if (schema.enum !== undefined) {
    assert.ok(schema.enum.some((e) => Object.is(e, value)), `${at}: '${JSON.stringify(value)}' not in enum`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((t) => typeMatches(t, value)), `${at}: expected ${types.join("|")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${at}: minLength`);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${at}: maxLength`);
    if (schema.pattern !== undefined) assert.ok(new RegExp(schema.pattern).test(value), `${at}: pattern ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${at}: minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${at}: minItems`);
    if (schema.uniqueItems) {
      assert.equal(new Set(value.map((v) => JSON.stringify(v))).size, value.length, `${at}: uniqueItems`);
    }
    if (schema.items !== undefined) value.forEach((item, i) => assertSchema(schema.items!, item, `${at}[${i}]`));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${at}: missing required '${key}'`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertSchema(child, value[key], `${at}.${key}`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) assert.ok(allowed.has(key), `${at}: unknown field '${key}'`);
    }
  }
}

async function loadSchema(file: string): Promise<SchemaNode> {
  return JSON.parse(await fs.readFile(path.join(CONTRACTS, file), "utf8")) as SchemaNode;
}

function throwsSchema(fn: () => unknown, what: string): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err !== null, `${what}: expected rejection`);
  assert.equal((err as { code?: unknown }).code, "E_SCHEMA", `${what}: expected E_SCHEMA`);
}

const GOOD_ARTIFACT = {
  path: "artifacts/D001.png",
  sha256: "a".repeat(64),
  validator_version: 1,
  validated_at: "2026-11-11",
  checks: ["opens", "exports"],
  ready: true,
};

function goodDecision(): Record<string, unknown> {
  return {
    ...decisionBase("D001", {
      title: "Platform scope",
      question: "Which platform?",
      status: "accepted",
      gate_ref: "G-DESIGN-REVIEW",
      evidence: [{ type: "review", ref: "artifacts/design.md", sha256: "b".repeat(64) }],
      artifacts: [GOOD_ARTIFACT],
    }),
  } as unknown as Record<string, unknown>;
}

const GATE_CHECK = {
  criterion: "contrast AA",
  evidence_ref: "artifacts/contrast.json",
  verifier_role: "accessibility",
  verdict: "pass",
  date: "2026-11-11",
};

function goodGate(): Record<string, unknown> {
  return {
    gate_id: "G-DESIGN-REVIEW",
    stage: "visual-system",
    checklist: [GATE_CHECK],
    decision: "pass",
    approver: "lead@example",
    owner: "designer@example",
    waivers: [],
  };
}

const COVERAGE_SCREEN = {
  screen: "checkout-payment",
  states: ["default", "error"],
  breakpoints: ["mobile-390", "desktop-1440"],
  decision: "in",
  rationale: "payment failure is critical",
};

function goodCoverage(): Record<string, unknown> {
  return {
    brief_id: "B-001",
    platforms: ["desktop-1440", "mobile-390"],
    screens: [COVERAGE_SCREEN],
  };
}

test("decision contract: good record validates, bad records are rejected by both validators", async () => {
  const schema = await loadSchema("decision-schema.json");
  const good = goodDecision();
  assertSchema(schema, good);
  assert.doesNotThrow(() => validateDecision(good));
  const stored = { ...good, review_state: "current", decision_hash: "c".repeat(64) };
  assertSchema(schema, stored);
  assert.doesNotThrow(() => validateStoredDecision(stored));

  const { evidence: _evidence, ...missingEvidence } = good;
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown field", { ...good, extra: true }],
    ["bad id", { ...good, id: "D12" }],
    ["missing evidence", missingEvidence],
    ["bad artifact sha", { ...good, artifacts: [{ ...GOOD_ARTIFACT, sha256: "NOT-A-SHA" }] }],
    ["bad status enum", { ...good, status: "done" }],
  ];
  for (const [name, record] of bad) {
    assert.throws(() => assertSchema(schema, record), `${name}: schema must reject`);
    throwsSchema(() => validateDecision(record), `${name}: TS validator must reject`);
  }
});

test("change-event contract: good record validates, bad records are rejected by both validators", async () => {
  const schema = await loadSchema("change-event-schema.json");
  const good = scenarioEvent() as unknown as Record<string, unknown>;
  assertSchema(schema, good);
  assert.doesNotThrow(() => validateChangeEvent(good));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown field", { ...good, extra: 1 }],
    ["bad claim id", { ...good, claim_id: "platform" }],
    ["missing author", (({ author: _author, ...rest }) => rest)(good)],
    ["empty reason", { ...good, reason: "" }],
  ];
  for (const [name, record] of bad) {
    assert.throws(() => assertSchema(schema, record), `${name}: schema must reject`);
    throwsSchema(() => validateChangeEvent(record), `${name}: TS validator must reject`);
  }
});

test("gate contract: good record validates, bad records are rejected by both validators", async () => {
  const schema = await loadSchema("gate-schema.json");
  const good = goodGate();
  assertSchema(schema, good);
  assert.doesNotThrow(() => validateGate(good));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown field", { ...good, extra: true }],
    ["bad gate id", { ...good, gate_id: "G-lower" }],
    ["empty checklist", { ...good, checklist: [] }],
    ["missing evidence_ref", { ...good, checklist: [{ criterion: "c", verifier_role: "r", verdict: "pass", date: "d" }] }],
    ["bad verdict", { ...good, checklist: [{ ...GATE_CHECK, verdict: "maybe" }] }],
  ];
  for (const [name, record] of bad) {
    assert.throws(() => assertSchema(schema, record), `${name}: schema must reject`);
    throwsSchema(() => validateGate(record), `${name}: TS validator must reject`);
  }
});

test("coverage contract: good record validates, bad records are rejected by both validators", async () => {
  const schema = await loadSchema("coverage-matrix-schema.json");
  const good = goodCoverage();
  assertSchema(schema, good);
  assert.doesNotThrow(() => validateCoverage(good));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown field", { ...good, extra: true }],
    ["empty platforms", { ...good, platforms: [] }],
    ["empty screens", { ...good, screens: [] }],
    ["bad inclusion", { ...good, screens: [{ ...COVERAGE_SCREEN, decision: "maybe" }] }],
  ];
  for (const [name, record] of bad) {
    assert.throws(() => assertSchema(schema, record), `${name}: schema must reject`);
    throwsSchema(() => validateCoverage(record), `${name}: TS validator must reject`);
  }
});

test("journal contract: an emitted entry validates; malformed entries are rejected", async () => {
  const schema = await loadSchema("run-journal-schema.json");
  const project = await tempDir("tasteful-contract-journal-");
  const p = projectPaths(project);
  const entry = await appendJournal(p, { tastefulVersion: TASTEFUL_VERSION, piVersion: PI_VERSION }, {
    kind: "command",
    actor: "human",
    payload: { command: "status" },
  });
  assertSchema(schema, entry);
  assert.deepEqual((await verifyJournal(p)).map((e) => e.seq), [1]);
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown field", { ...entry, extra: true }],
    ["bad kind", { ...entry, kind: "bogus" }],
    ["bad payload hash", { ...entry, payload_hash: "ABC" }],
    ["missing versions.pi", { ...entry, versions: { tasteful: TASTEFUL_VERSION } }],
    ["bad seq", { ...entry, seq: 0 }],
  ];
  for (const [name, record] of bad) {
    assert.throws(() => assertSchema(schema, record), `${name}: schema must reject`);
  }
});

// ---------------------------------------------------------------------------
// Adapter matrix is normative: the argv in the doc row must be the code argv.

function matrixTokens(cell: string): string[] {
  const raw = cell.trim().replace(/^`/, "").replace(/`$/, "");
  assert.ok(!/(^|\s)-o(\s|<)/.test(raw), "adapter-matrix must document --out, not -o");
  return raw.replace(/[[\]]/g, " ").replace(/…/g, " ").split(/\s+/).filter((t) => t.length > 0 && t !== "figcraft-cli");
}

async function matrixRow(op: string): Promise<string> {
  const text = await fs.readFile(path.join(CONTRACTS, "adapter-matrix.md"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith(`| \`${op}\` |`));
  assert.ok(line !== undefined, `adapter-matrix.md: missing '${op}' row`);
  return (line.split("|")[2] ?? "").trim();
}

test("adapter matrix argv equals buildInfoArgv/buildExportArgv token-for-token", async () => {
  const values: Record<string, string> = {
    "<FILE>": "/proj/a.figcraft",
    "<OUT>": "/proj/.tasteful/exports/x.png",
    R: "/proj",
    W: "/proj/.tasteful/exports",
    F: "png",
    P: "1",
    N: "12",
    S: "2",
  };
  const concretize = (tokens: string[]): string[] => tokens.map((t) => values[t] ?? t);

  const exportDoc = concretize(matrixTokens(await matrixRow("export")));
  const exportCode = buildExportArgv(
    { file: "/proj/a.figcraft", out: "/proj/.tasteful/exports/x.png", format: "png", page: "1", node: "12", scale: "2" },
    { read: ["/proj"], write: ["/proj/.tasteful/exports"] },
  );
  assert.deepEqual(exportDoc, exportCode);
  assert.ok(exportCode.includes("--out"));
  assert.ok(!exportCode.includes("-o"));

  const infoDoc = concretize(matrixTokens(await matrixRow("info")));
  const infoCode = buildInfoArgv("/proj/a.figcraft", { read: ["/proj"], write: [] });
  assert.deepEqual(infoDoc, infoCode);
});

// ---------------------------------------------------------------------------
// Loader identity: inline-only, no discovery surfaces, no poison consumption.

test("product loader is inline-only and never consumes ambient .pi/.agents state", async () => {
  const project = await tempDir("tasteful-contract-loader-proj-");
  const home = await tempDir("tasteful-contract-loader-home-");
  const poison = async (file: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  };
  await poison(path.join(project, ".pi", "extensions", "evil.js"), "throw new Error('EVIL-EXT-LOADED');\n");
  await poison(path.join(project, ".pi", "settings.json"), '{"marker":"POISON-SETTINGS"}\n');
  await poison(path.join(project, ".pi", "SYSTEM.md"), "POISON-SYSTEM\n");
  await poison(path.join(project, ".pi", "APPEND_SYSTEM.md"), "POISON-APPEND\n");
  await poison(path.join(project, ".agents", "skills", "evil", "SKILL.md"), "POISON-SKILL\n");
  await poison(path.join(project, "AGENTS.md"), "POISON-AGENTS\n");
  await poison(path.join(project, "CLAUDE.md"), "POISON-CLAUDE\n");
  await poison(path.join(home, ".agents", "skills", "ambient", "SKILL.md"), "POISON-HOME-SKILL\n");

  const prevHome = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = home;
  try {
    const reg = { projectRoot: project, journal: { tastefulVersion: TASTEFUL_VERSION, piVersion: PI_VERSION } };
    const loader = createProductLoader(project, reg);
    assert.equal(loader.constructor.name, "ProductResourceLoader");
    await loader.reload();

    const ext = loader.getExtensions();
    assert.deepEqual(ext.errors, []);
    assert.equal(ext.extensions.length, 1, "only the inline product extension may load");
    assert.equal(ext.extensions[0]?.path, "<inline:tasteful-tools>");
    assert.equal(ext.extensions[0]?.tools.size, PRODUCT_TOOL_NAMES.length);
    assert.equal(ext.extensions[0]?.handlers.get("before_provider_headers")?.length, 1);
    assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
    assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
    assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.equal(loader.getSystemPrompt(), TASTEFUL_SYSTEM_PROMPT);
    const visible = JSON.stringify({
      names: ext.extensions.map((e) => e.path),
      skills: loader.getSkills(),
      prompts: loader.getPrompts(),
      themes: loader.getThemes(),
      agents: loader.getAgentsFiles(),
      prompt: loader.getSystemPrompt(),
    });
    assert.ok(!visible.includes("POISON"), "poison text must not reach loader output");
    assert.ok(!visible.includes("EVIL"), "poison extension must not load");
    assert.equal(createProductSettingsManager().getEnableInstallTelemetry(), false);
  } finally {
    if (prevHome === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevHome;
  }
});

test("--help lists every implemented command, including info/fs/hash", () => {
  const help = helpText();
  const commands = [
    "init", "brief", "decision", "invalidate", "gate", "validate", "adapter",
    "info", "export", "approve", "accept", "fs", "run", "status", "hash",
  ];
  for (const cmd of commands) {
    assert.match(help, new RegExp(`^  ${cmd}\\b`, "m"), `help must list '${cmd}'`);
  }
  assert.match(help, /^  fs read --file/m);
  assert.match(help, /^  fs write --file/m);
  assert.match(help, /^  hash --file/m);
  assert.match(help, /^  gate accept \(--id <G> \| --file <json>\) --approver/m);
  assert.match(help, /^  accept \(--decision <D> \| --file <json>\) --approver/m);
  assert.match(help, /--out <path>/);
  assert.ok(!/(^|\s)-o(\s|<)/.test(help), "help must document --out, not -o");
});
