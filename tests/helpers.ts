/** Shared test helpers: temp HOME, temp project, scenario fixtures. */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, computeGateContentHash } from "../src/design/hashes.js";
import type { Decision, Gate } from "../src/design/schema.js";
import { readGate, type ProjectPaths } from "../src/design/store.js";
import { gateUpsert, grantGateApproval, makeToolContext } from "../src/host/tools.js";
import { validationRecordName } from "../src/artcraft/validate.js";

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Set TASTEFUL_HOME to a temp dir for the duration of the test. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tempDir("tasteful-home-");
  const prev = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prev;
  }
}

export function decisionBase(id: string, overrides?: Partial<Decision>): Decision {
  return {
    schema_version: 1,
    id,
    version: 1,
    title: `Decision ${id}`,
    question: `Question for ${id}?`,
    status: "proposed",
    owner: "designer@example",
    created_at: "2026-11-11",
    updated_at: "2026-11-11",
    claims: [],
    depends_on: [],
    evidence: [],
    alternatives: [],
    artifacts: [],
    ...overrides,
  };
}

/**
 * Optional BRIM fixture supplied by the caller. Tests that need it MUST skip
 * with the explicit reason from `brimSkipReason()` when it is absent, so a
 * clean checkout stays green without any machine-specific path.
 */
export const BRIM = process.env.TASTEFUL_BRIM ?? "";

export async function brimAvailable(): Promise<boolean> {
  if (!BRIM) return false;
  try {
    return (await fs.stat(BRIM)).isFile();
  } catch {
    return false;
  }
}

/** `false` when BRIM exists, otherwise an explicit node:test skip reason. */
export async function brimSkipReason(): Promise<string | false> {
  if (!BRIM) {
    return "BRIM fixture missing (TASTEFUL_BRIM unset); set TASTEFUL_BRIM to run this test";
  }
  return (await brimAvailable())
    ? false
    : `BRIM fixture missing at ${BRIM}; set TASTEFUL_BRIM to run this test`;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, canonicalJson(value) + "\n", "utf8");
}

/**
 * Persist a pass gate through the real human flow: grant a content-bound
 * gate_accept approval, consume it via the human gate tool, and return the
 * stored gate (which now carries approval_digest provenance). Tests that
 * bypass this and hand-write a pass gate must fail acceptance with
 * E_GATE_BLOCKED.
 */
export async function installApprovedGate(
  p: ProjectPaths,
  gate: Gate,
  approver: string = gate.approver,
): Promise<Gate> {
  const { digest } = await grantGateApproval(p, {
    gate_id: gate.gate_id,
    owner: gate.owner,
    approver,
    contentHash: computeGateContentHash(gate),
  });
  const human = makeToolContext(p.root, { tastefulVersion: "0.1.0", piVersion: "1.5.2" }, "human");
  await gateUpsert(human, { gate, approval_id: digest });
  return readGate(p, gate.gate_id);
}

/**
 * Hand-write a passing validation record for acceptance fixtures whose subject
 * is approval/gate/re-review semantics rather than artifact execution. The
 * record matches validationRecordName/parseValidationRecord and is fresh
 * against the artifact's current mtime. Tests that exercise the check runner
 * itself use artifact_validate instead.
 */
export async function seedPassingValidationRecord(
  p: ProjectPaths,
  input: {
    decisionId: string;
    artifactPath: string;
    sha256: string;
    checks?: string[];
    validatedAt?: string;
  },
): Promise<string> {
  const abs = path.isAbsolute(input.artifactPath)
    ? input.artifactPath
    : path.join(p.root, input.artifactPath);
  const st = await fs.stat(abs);
  const validatedAt = input.validatedAt ?? new Date().toISOString();
  const checks = [...new Set(input.checks ?? ["opens"])];
  const record = {
    schema_version: 1,
    decision_id: input.decisionId,
    artifact_path: input.artifactPath,
    sha256: input.sha256,
    validator_version: 1,
    results: checks.map((name) => ({ name, verdict: "pass", detail: "test fixture" })),
    validated_at: validatedAt,
    artifact_mtime_ms: Math.floor(st.mtimeMs),
  };
  // Names are operator aids only (acceptance matches record contents), so the
  // check-set suffix keeps fixture variants for one artifact from colliding.
  const suffix = checks.join("-").replace(/[^A-Za-z0-9-]/g, "_");
  const name = validationRecordName(input.decisionId, input.artifactPath, input.sha256)
    .replace(/\.json$/, `-${suffix}.json`);
  await writeJson(path.join(p.tasteful, "validations", name), record);
  return validatedAt;
}
