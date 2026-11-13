/**
 * Decision store: project layout, lockdir lock, atomic writes, index rebuild.
 * index.json is a rebuildable cache, never authoritative.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalJson, computeAuthoredContentHash, sha256Hex } from "./hashes.js";
import { SUPPORTED_ARTIFACT_CHECKS } from "../artcraft/validate.js";
import {
  computeDecisionHash,
  validateChangeEvent,
  validateDecision,
  validateGate,
  validateStoredDecision,
  type ChangeEvent,
  type Decision,
  type DecisionArtifact,
  type Evidence,
  type Gate,
  type ReviewState,
} from "./schema.js";

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export const TASTEFUL_DIR = ".tasteful";

export interface ProjectPaths {
  root: string;
  tasteful: string;
  decisions: string;
  gates: string;
  events: string;
  approvals: string;
  journal: string;
  exports: string;
  validations: string;
  lock: string;
}

export function projectPaths(root: string): ProjectPaths {
  const tasteful = path.join(root, TASTEFUL_DIR);
  return {
    root,
    tasteful,
    decisions: path.join(tasteful, "decisions"),
    gates: path.join(tasteful, "gates"),
    events: path.join(tasteful, "events"),
    approvals: path.join(tasteful, "approvals"),
    journal: path.join(tasteful, "journal"),
    exports: path.join(tasteful, "exports"),
    validations: path.join(tasteful, "validations"),
    lock: path.join(tasteful, ".lock"),
  };
}

async function ensureStateDir(dir: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await fs.mkdir(dir);
    st = await fs.lstat(dir);
  }
  if (st.isSymbolicLink()) {
    throw new StoreError("E_PATH_SYMLINK", `refusing symlinked project state: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new StoreError("E_PATH", `project state root is not a directory: ${dir}`);
  }
}

/**
 * Revalidate project state roots on every operation. Init-time checks alone
 * are not enough: a project bundle can swap `.tasteful` or one of its child
 * roots for a symlink after init and redirect writes outside the project.
 *
 * Missing roots are tolerated (first init), but any root that exists must be
 * a real directory (`E_PATH_SYMLINK` / `E_PATH`), `.tasteful` must resolve to
 * `<realpath(root)>/.tasteful`, and `exports` must resolve inside the project
 * (`E_PATH_ESCAPE`).
 */
export async function assertStateRoots(p: ProjectPaths): Promise<void> {
  const roots = [p.tasteful, p.decisions, p.gates, p.events, p.approvals, p.journal, p.exports, p.validations];
  for (const dir of roots) {
    let st;
    try {
      st = await fs.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new StoreError("E_PATH_SYMLINK", `refusing symlinked project state: ${dir}`);
    }
    if (!st.isDirectory()) {
      throw new StoreError("E_PATH", `project state root is not a directory: ${dir}`);
    }
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(p.root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let realTasteful: string | null = null;
  try {
    realTasteful = await fs.realpath(p.tasteful);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (realTasteful !== null && realTasteful !== path.join(realRoot, TASTEFUL_DIR)) {
    throw new StoreError("E_PATH_SYMLINK", `project state root resolves elsewhere: ${p.tasteful}`);
  }
  let realExports: string | null = null;
  try {
    realExports = await fs.realpath(p.exports);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (realExports !== null && realExports !== realRoot && !realExports.startsWith(realRoot + path.sep)) {
    throw new StoreError("E_PATH_ESCAPE", `exports root escapes the project: ${p.exports}`);
  }
}

export async function initProject(root: string, name: string, tastefulVersion: string): Promise<ProjectPaths> {
  const p = projectPaths(root);
  await fs.mkdir(root, { recursive: true });
  for (const dir of [p.tasteful, p.decisions, p.gates, p.events, p.approvals, p.journal, p.exports, p.validations]) {
    await ensureStateDir(dir);
  }
  await assertStateRoots(p);
  const projectFile = path.join(p.tasteful, "project.json");
  try {
    await fs.stat(projectFile);
  } catch {
    await writeFileAtomic(
      projectFile,
      canonicalJson({
        schema_version: 1,
        name,
        created_at: new Date().toISOString().slice(0, 10),
        tasteful_version: tastefulVersion,
      }) + "\n",
    );
  }
  await rebuildIndex(p);
  return p;
}

/** Lockdir-based project lock. Stale locks (dead pid) are recovered. */
export async function withLock<T>(p: ProjectPaths, fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  await assertStateRoots(p);
  const timeoutMs = opts?.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(p.tasteful, { recursive: true });
  // Re-check after mkdir: a root that did not exist at the first probe must
  // not have appeared as a symlink.
  await assertStateRoots(p);
  for (;;) {
    try {
      await fs.mkdir(p.lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await tryReapStaleLock(p)) continue;
      if (Date.now() >= deadline) {
        throw new StoreError("E_LOCK_BUSY", `project is locked: ${p.lock}`);
      }
      await sleep(25);
    }
  }
  const owner = path.join(p.lock, "owner.json");
  await fs.writeFile(owner, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  try {
    return await fn();
  } finally {
    await fs.rm(p.lock, { recursive: true, force: true });
  }
}

async function tryReapStaleLock(p: ProjectPaths): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(p.lock, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: number; at?: number };
    if (typeof owner.pid === "number" && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false; // alive
      } catch {
        // dead -> reap
      }
    } else if (typeof owner.at === "number" && Date.now() - owner.at < 30000) {
      return false; // fresh lock without pid; leave it
    }
    await fs.rm(p.lock, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Atomic write: temp file in same dir + fsync + rename. */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export function decisionFile(p: ProjectPaths, id: string): string {
  if (typeof id !== "string" || !/^D[0-9]+$/.test(id) || id.includes("/") || id.includes("\\")) {
    throw new StoreError("E_PATH", `bad decision id: ${String(id)}`);
  }
  const file = path.join(p.decisions, `${id}.json`);
  if (path.dirname(file) !== p.decisions) throw new StoreError("E_PATH", `decision path escapes decisions dir: ${id}`);
  return file;
}

export async function listDecisionIds(p: ProjectPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.decisions);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^D[0-9]+\.json$/.test(e))
    .map((e) => e.slice(0, -5))
    .sort();
}

/**
 * Read + verify a stored decision. Rejects filename/id divergence and any
 * authored-content hash mismatch (hand edit or partial writer).
 */
export async function readDecision(p: ProjectPaths, id: string): Promise<Decision> {
  const raw = await readJsonFile<unknown>(decisionFile(p, id));
  const d = validateStoredDecision(raw);
  if (d.id !== id) {
    throw new StoreError("E_SCHEMA", `decision file ${id}.json contains id '${d.id}'`);
  }
  if (!d.decision_hash) {
    throw new StoreError("E_HASH_MISMATCH", `decision ${id}: missing decision_hash`);
  }
  const recomputed = computeDecisionHash(d);
  if (recomputed !== d.decision_hash) {
    throw new StoreError("E_HASH_MISMATCH", `decision ${id}: decision_hash mismatch`);
  }
  return d;
}

/**
 * System-only decision write: bypasses the authored-input guard (review_state
 * is derived), recomputes decision_hash, validates the stored shape, and
 * writes atomically. Used by closure, validation and re-review transitions —
 * never exposed as a model tool.
 */
export async function writeDecisionRecord(
  p: ProjectPaths,
  input: Decision,
  opts?: { rebuild?: boolean },
): Promise<Decision> {
  const stored = validateStoredDecision({
    ...input,
    decision_hash: computeDecisionHash(input),
  });
  await writeFileAtomic(decisionFile(p, stored.id), canonicalJson(stored) + "\n");
  if (opts?.rebuild !== false) await rebuildIndex(p);
  return stored;
}

export async function readAllDecisions(p: ProjectPaths): Promise<Map<string, Decision>> {
  const out = new Map<string, Decision>();
  for (const id of await listDecisionIds(p)) {
    out.set(id, await readDecision(p, id));
  }
  return out;
}

export interface UpsertOptions {
  /** Human approval record id authorizing `accepted`. Required for accepted. */
  approvalId?: string;
  /** Check that the named gate currently passes. */
  gatePasses?: (gateRef: string) => Promise<boolean>;
  /**
   * Check a single-use approval bound to the decision id and the exact
   * authored-content hash of the submitted decision.
   */
  approvalValid?: (approvalId: string, owner: string, decisionId: string, contentHash: string) => Promise<boolean>;
  /** Resolve + hash one accepted artifact. Required for accepted decisions. */
  validateArtifact?: (artifact: DecisionArtifact, decisionId: string) => Promise<void>;
  /** Verify one accepted evidence ref (optional; the host supplies it). */
  validateEvidence?: (evidence: Evidence, decisionId: string) => Promise<void>;
}

/** Supported artifact validator contract version (acceptance rejects others). */
export const SUPPORTED_ARTIFACT_VALIDATOR_VERSION = 1;

/**
 * Validate + write a decision. Enforces: strict schema, depends_on targets
 * exist, no cycles, `accepted` preconditions. Rebuilds the index.
 */
export async function upsertDecision(
  p: ProjectPaths,
  input: unknown,
  opts?: UpsertOptions,
): Promise<Decision> {
  const d = validateDecision(input);
  const all = await readAllDecisions(p);
  const existing = all.get(d.id);
  for (const dep of d.depends_on) {
    if (dep !== d.id && !all.has(dep)) {
      throw new StoreError("E_DEP_MISSING", `decision ${d.id}: unknown depends_on '${dep}'`);
    }
  }
  all.set(d.id, d);
  const cycle = findCycle(all);
  if (cycle) {
    throw new StoreError("E_CYCLE", `decision graph cycle: ${cycle.join(" -> ")}`);
  }
  // The acceptance approval binds exactly this canonical authored content.
  const contentHash = computeAuthoredContentHash(d);
  let accepted = false;
  if (d.status === "accepted") {
    await assertAcceptedPreconditions(d, opts);
    if (d.gate_ref) {
      const passes = opts?.gatePasses ? await opts.gatePasses(d.gate_ref) : false;
      if (!passes) throw new StoreError("E_GATE_BLOCKED", `gate ${d.gate_ref} does not pass`);
    } else {
      throw new StoreError("E_GATE_BLOCKED", `accepted decision ${d.id} requires gate_ref`);
    }
    if (!opts?.approvalId || !opts?.approvalValid) {
      throw new StoreError("E_ACCEPT_NO_APPROVAL", `accepted decision ${d.id} requires human approval`);
    }
    accepted = true;
  }
  if (opts?.approvalId) {
    if (!opts.approvalValid) {
      throw new StoreError("E_ACCEPT_NO_APPROVAL", `decision ${d.id}: approval verifier unavailable`);
    }
    // Consumes the single-use record; throws E_APPROVAL_MISMATCH when the
    // submitted content (or target/params) differs from what was approved.
    const ok = await opts.approvalValid(opts.approvalId, d.owner, d.id, contentHash);
    if (!ok) throw new StoreError("E_ACCEPT_NO_APPROVAL", `approval invalid for ${d.id}`);
  }
  // review_state is derived and never authored: an update carries the state
  // written by the last closure/validation transition; only new records start
  // `current`. The sole exception is the human re-review transition: an
  // approved accepted upsert clears a non-current state AND re-marks artifacts
  // ready after `assertAcceptedPreconditions` re-hashed every artifact above.
  let review_state: ReviewState = existing?.review_state ?? "current";
  let artifacts = d.artifacts;
  if (accepted && existing && review_state !== "current") {
    review_state = "current";
    artifacts = d.artifacts.map((a) => ({ ...a, ready: true }));
  }
  return writeDecisionRecord(p, {
    ...d,
    artifacts,
    review_state,
  });
}

async function assertAcceptedPreconditions(d: Decision, opts?: UpsertOptions): Promise<void> {
  if (!d.owner) throw new StoreError("E_ACCEPT_NO_OWNER", `${d.id}: accepted requires owner`);
  if (d.evidence.length < 1) throw new StoreError("E_ACCEPT_NO_EVIDENCE", `${d.id}: accepted requires evidence`);
  for (const e of d.evidence) {
    if (!e.sha256) throw new StoreError("E_ACCEPT_NO_EVIDENCE", `${d.id}: evidence '${e.ref}' lacks sha256`);
  }
  // Project-relative evidence refs must exist and hash-match; external refs
  // are verified (and journaled) by the required host callback.
  if (!opts?.validateEvidence) {
    throw new StoreError("E_ACCEPT_NO_EVIDENCE", `${d.id}: acceptance requires evidence verification`);
  }
  for (const e of d.evidence) await opts.validateEvidence(e, d.id);
  if (d.artifacts.length < 1) {
    throw new StoreError("E_ACCEPT_NO_ARTIFACT", `${d.id}: accepted requires a validated artifact`);
  }
  for (const a of d.artifacts) {
    if (a.ready === false) {
      throw new StoreError("E_ACCEPT_NO_ARTIFACT", `${d.id}: artifact '${a.path}' not ready`);
    }
    if (!a.validated_at) {
      throw new StoreError("E_ACCEPT_NO_ARTIFACT", `${d.id}: artifact '${a.path}' lacks validated_at`);
    }
    if (!a.checks || a.checks.length === 0) {
      throw new StoreError("E_ACCEPT_NO_ARTIFACT", `${d.id}: artifact '${a.path}' lacks validation checks`);
    }
    for (const check of a.checks) {
      if (!(SUPPORTED_ARTIFACT_CHECKS as readonly string[]).includes(check)) {
        throw new StoreError(
          "E_ACCEPT_NO_ARTIFACT",
          `${d.id}: artifact '${a.path}' has unsupported check '${check}' (supported: ${SUPPORTED_ARTIFACT_CHECKS.join(", ")})`,
        );
      }
    }
    if (Number.isNaN(Date.parse(a.validated_at))) {
      throw new StoreError(
        "E_ACCEPT_NO_ARTIFACT",
        `${d.id}: artifact '${a.path}' has unparseable validated_at '${a.validated_at}'`,
      );
    }
    if (a.validator_version !== SUPPORTED_ARTIFACT_VALIDATOR_VERSION) {
      throw new StoreError(
        "E_ACCEPT_NO_ARTIFACT",
        `${d.id}: artifact '${a.path}' validator_version ${a.validator_version} unsupported (expected ${SUPPORTED_ARTIFACT_VALIDATOR_VERSION})`,
      );
    }
  }
  // Existence/hash verification is not optional: without it a fabricated
  // path + 64-hex hash would be accepted.
  if (!opts?.validateArtifact) {
    throw new StoreError("E_ACCEPT_NO_ARTIFACT", `${d.id}: acceptance requires artifact verification`);
  }
  for (const a of d.artifacts) await opts.validateArtifact(a, d.id);
}

/** Returns the cycle path if the depends_on graph has one. */
export function findCycle(all: Map<string, Decision>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  for (const id of all.keys()) color.set(id, WHITE);
  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    const deps = all.get(id)?.depends_on ?? [];
    for (const dep of deps) {
      if (!all.has(dep)) continue;
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(dep);
        return [...stack.slice(i), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const id of [...all.keys()].sort()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

export interface DecisionIndex {
  schema_version: 1;
  decisions: Record<string, { version: number; status: string; review_state: ReviewState; decision_hash: string }>;
  edges: Array<{ from: string; to: string }>;
  index_hash: string;
}

/** Rebuild index.json deterministically (sorted keys/edges). Byte-identical across rebuilds. */
export async function rebuildIndex(p: ProjectPaths): Promise<DecisionIndex> {
  const all = await readAllDecisions(p);
  const ids = [...all.keys()].sort();
  const decisions: DecisionIndex["decisions"] = {};
  const edges: DecisionIndex["edges"] = [];
  for (const id of ids) {
    const d = all.get(id)!;
    decisions[id] = {
      version: d.version,
      status: d.status,
      review_state: d.review_state ?? "current",
      decision_hash: d.decision_hash ?? computeDecisionHash(d),
    };
    for (const dep of [...d.depends_on].sort()) {
      edges.push({ from: id, to: dep });
    }
  }
  edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
  const body = { schema_version: 1 as const, decisions, edges };
  const index_hash = sha256Hex(canonicalJson(body));
  const index: DecisionIndex = { ...body, index_hash };
  await writeFileAtomic(path.join(p.decisions, "index.json"), canonicalJson(index) + "\n");
  return index;
}

export function gateFile(p: ProjectPaths, gateId: string): string {
  if (typeof gateId !== "string" || !/^G-[A-Z0-9-]+$/.test(gateId) || gateId.includes("/") || gateId.includes("\\")) {
    throw new StoreError("E_PATH", `bad gate id: ${String(gateId)}`);
  }
  const file = path.join(p.gates, `${gateId}.json`);
  if (path.dirname(file) !== p.gates) throw new StoreError("E_PATH", `gate path escapes gates dir: ${gateId}`);
  return file;
}

export async function readGate(p: ProjectPaths, gateId: string): Promise<Gate> {
  const g = validateGate(await readJsonFile<unknown>(gateFile(p, gateId)));
  if (g.gate_id !== gateId) {
    throw new StoreError("E_SCHEMA", `gate file ${gateId}.json contains id '${g.gate_id}'`);
  }
  return g;
}

export async function writeGate(p: ProjectPaths, input: unknown): Promise<Gate> {
  const g = validateGate(input);
  await writeFileAtomic(gateFile(p, g.gate_id), canonicalJson(g) + "\n");
  return g;
}

/**
 * Gate-revoke transition data step. The caller holds the project lock, has
 * validated the human revoke (pass gate, approver != owner), and has already
 * written the gate with `decision: "revoked"`. Every accepted decision whose
 * `gate_ref` is this gate becomes proposed/needs_review with all artifacts no
 * longer ready; the index is rebuilt when anything changed. Returns sorted ids.
 */
export async function demoteGateDependents(p: ProjectPaths, gateId: string): Promise<string[]> {
  const all = await readAllDecisions(p);
  const day = new Date().toISOString().slice(0, 10);
  const demoted: string[] = [];
  for (const id of [...all.keys()].sort()) {
    const d = all.get(id)!;
    if (d.gate_ref !== gateId || d.status !== "accepted") continue;
    await writeDecisionRecord(
      p,
      {
        ...d,
        status: "proposed",
        review_state: "needs_review",
        updated_at: day,
        artifacts: d.artifacts.map((a) => ({ ...a, ready: false })),
      },
      { rebuild: false },
    );
    demoted.push(id);
  }
  if (demoted.length > 0) await rebuildIndex(p);
  return demoted;
}

export function eventFile(p: ProjectPaths, eventId: string): string {
  return path.join(p.events, `${eventId}.json`);
}

export async function writeEvent(p: ProjectPaths, input: unknown): Promise<ChangeEvent> {
  const e = validateChangeEvent(input);
  const file = eventFile(p, e.event_id);
  // Change events are append-only: never overwrite an existing record. This is
  // defense in depth behind decisionInvalidate's max-suffix+1 derivation (a
  // restored/hand-edited bundle with an id gap must not lose event history).
  let exists = true;
  try {
    await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    exists = false;
  }
  if (exists) throw new StoreError("E_EVENT_EXISTS", `event already exists: ${e.event_id}`);
  await writeFileAtomic(file, canonicalJson(e) + "\n");
  return e;
}
