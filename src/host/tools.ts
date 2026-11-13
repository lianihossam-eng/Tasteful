/**
 * Product tools: pure implementations of (ctx, params) -> result, plus thin
 * pi ToolDefinition registration. fs_* enforces realpath + allowlist +
 * size limits + escape rejection + TOCTOU re-check after approval.
 */
import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson, computeGateContentHash, hashFile, sha256Hex } from "../design/hashes.js";
import {
  isRecord,
  validateChangeEvent,
  validateGate,
  type ChangeEvent,
  type Decision,
  type DecisionArtifact,
  type Evidence,
  type Gate,
} from "../design/schema.js";
import { applyClosure, collectReverseDependents, computeClosure } from "../design/invalidate.js";
import { assertNotSelf, canonicalIdentity, sameIdentity } from "../design/identity.js";
import { assertGatePassable } from "../design/gates.js";
import {
  eventFile,
  gateFile,
  projectPaths,
  readAllDecisions,
  readDecision,
  readGate,
  rebuildIndex,
  upsertDecision,
  withLock,
  writeEvent,
  writeDecisionRecord,
  writeFileAtomic,
  writeGate,
  decisionFile,
  demoteGateDependents,
  assertStateRoots,
  type ProjectPaths,
} from "../design/store.js";
import {
  ApprovalError,
  consumeApproval,
  consumeContentBoundApproval,
  grantContentBoundApproval,
  readApprovalRecord,
} from "./approvals.js";
import { appendJournal, preflightJournal, verifyJournal, type JournalContext } from "./journal.js";
import { agentDir } from "./paths.js";
import { figcraftExport, figcraftInfo, type AdapterRoots } from "../artcraft/figcraft.js";
import {
  parseValidationRecord,
  runArtifactChecks,
  SUPPORTED_ARTIFACT_CHECKS,
  VALIDATION_RECORD_SCHEMA_VERSION,
  validationRecordName,
  type ArtifactCheckResult,
} from "../artcraft/validate.js";
import {
  adapterCheck,
  buildCanaryInfoArgv,
  journalAdapterRun,
  type Handshake,
} from "../artcraft/matrix.js";

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export interface ToolContext {
  project: ProjectPaths;
  roots: AdapterRoots;
  journal: JournalContext;
  /** Who invoked the tool: agent (model) or human (CLI direct). */
  actor: "agent" | "human";
}

export function makeToolContext(projectRoot: string, journal: JournalContext, actor: "agent" | "human" = "human"): ToolContext {
  const project = projectPaths(projectRoot);
  return {
    project,
    roots: { read: [projectRoot], write: [project.exports] },
    journal,
    actor,
  };
}

export const FS_READ_DEFAULT_MAX = 256 * 1024;
export const FS_READ_HARD_MAX = 1024 * 1024;
/** fs_read always hashes the whole file; larger files are rejected. */
export const FS_READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const FS_WRITE_HARD_MAX = 1024 * 1024;

/** Reserved project state; model and CLI writes must never touch it. */
export const RESERVED_STATE_DIRS = ["decisions", "journal", "approvals", "events", "gates", "validations", ".lock"] as const;

export function assertNotReserved(project: ProjectPaths, absPath: string): void {
  const resolved = path.resolve(absPath);
  // `absPath` comes from resolveProjectPath (a real path). The project root may
  // itself be a symlink, so compare against the real state root or the prefix
  // test misses every reserved directory.
  let realTasteful: string;
  try {
    realTasteful = realpathSync(project.tasteful);
  } catch {
    realTasteful = path.resolve(project.tasteful);
  }
  for (const name of RESERVED_STATE_DIRS) {
    const dir = path.join(realTasteful, name);
    if (resolved === dir || resolved.startsWith(dir + path.sep)) {
      throw new ToolError("E_PATH_RESERVED", `reserved project state: ${path.join(".tasteful", name)}`);
    }
  }
}

/**
 * Resolve a project-relative path against the allowlist. Rejects absolute
 * escapees, `..` escapes, symlink escapes, /proc-style paths, and ~/.pi.
 */
export async function resolveProjectPath(
  ctx: ToolContext,
  userPath: string,
  opts?: { mustExist?: boolean },
): Promise<string> {
  if (typeof userPath !== "string" || userPath.length === 0 || userPath.length > 1024) {
    throw new ToolError("E_PATH", "path must be a non-empty string");
  }
  if (userPath.includes("\0")) throw new ToolError("E_PATH", "NUL in path");
  await assertStateRoots(ctx.project);
  const home = process.env.HOME ?? process.env.TASTEFUL_HOME ?? "";
  // Block /proc/self/fd-style and device paths outright.
  if (/(^|\/)\.\.(\/|$)/.test(userPath.replace(/\\/g, "/")) && path.isAbsolute(userPath)) {
    throw new ToolError("E_PATH_ESCAPE", "absolute path with .. rejected");
  }
  if (userPath.startsWith("/proc/") || userPath.startsWith("/sys/") || userPath.startsWith("/dev/")) {
    throw new ToolError("E_PATH_ESCAPE", "system path rejected");
  }
  const abs = path.isAbsolute(userPath) ? path.normalize(userPath) : path.join(ctx.project.root, userPath);
  // Explicit ~/.pi block even before realpath.
  if (home && (abs === path.join(home, ".pi") || abs.startsWith(path.join(home, ".pi") + path.sep))) {
    throw new ToolError("E_PATH_ESCAPE", "~/.pi is outside the allowlist");
  }
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !opts?.mustExist) {
      // For writes: resolve the parent, then append the leaf (leaf must not be a symlink).
      const parent = path.dirname(abs);
      let realParent: string;
      try {
        realParent = await fs.realpath(parent);
      } catch {
        throw new ToolError("E_PATH_ESCAPE", `parent does not resolve inside roots: ${userPath}`);
      }
      const leaf = path.basename(abs);
      if (leaf === "." || leaf === ".." || leaf.length === 0) throw new ToolError("E_PATH", "bad leaf");
      try {
        const lst = await fs.lstat(path.join(realParent, leaf));
        if (lst.isSymbolicLink()) throw new ToolError("E_PATH_ESCAPE", "symlink leaf rejected");
      } catch (e) {
        if ((e as ToolError).code === "E_PATH_ESCAPE") throw e;
        // ENOENT leaf is fine.
      }
      real = path.join(realParent, leaf);
    } else {
      throw new ToolError("E_PATH", `path does not resolve: ${userPath}`);
    }
  }
  const allowed = [ctx.project.root, ctx.project.exports];
  let realAllowed = false;
  for (const a of allowed) {
    let ra: string;
    try {
      ra = await fs.realpath(a);
    } catch {
      continue;
    }
    if (real === ra || real.startsWith(ra + path.sep)) {
      realAllowed = true;
      break;
    }
  }
  if (!realAllowed) throw new ToolError("E_PATH_ESCAPE", `path escapes project roots: ${userPath}`);
  // The product's own agent state (auth.json, models.json, sessions) is never
  // a product file, even when the project root is the user's home. Resolve the
  // agent dir so a symlinked agent root cannot be used as an alias.
  let realAgent: string | null = null;
  try {
    realAgent = await fs.realpath(agentDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (realAgent !== null && (real === realAgent || real.startsWith(realAgent + path.sep))) {
    throw new ToolError("E_PATH_ESCAPE", "agent state is outside the allowlist");
  }
  if (home && (real === path.join(home, ".pi") || real.startsWith(path.join(home, ".pi") + path.sep))) {
    throw new ToolError("E_PATH_ESCAPE", "~/.pi is outside the allowlist");
  }
  if (opts?.mustExist) {
    try {
      const st = await fs.lstat(real);
      if (st.isFile() && st.nlink > 1) {
        throw new ToolError("E_PATH_HARDLINK", `hardlinked file rejected: ${userPath}`);
      }
    } catch (err) {
      if ((err as ToolError).code === "E_PATH_HARDLINK") throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return real;
}

/**
 * fs_write resolves without mustExist (a new file is the normal case), so the
 * resolve-time nlink check does not run. Reject an existing hardlinked target
 * explicitly: writeFileAtomic's rename would detach the other link rather than
 * modify it, but the hardlink-write policy is deny.
 */
async function assertNotHardlinkedTarget(target: string, userPath: string): Promise<void> {
  try {
    const st = await fs.lstat(target);
    if (st.isFile() && st.nlink > 1) {
      throw new ToolError("E_PATH_HARDLINK", `hardlinked write target rejected: ${userPath}`);
    }
  } catch (err) {
    if ((err as ToolError).code === "E_PATH_HARDLINK") throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---- fs tools ----

export async function fsList(ctx: ToolContext, params: { path: string }): Promise<{ entries: Array<{ name: string; type: string }> }> {
  const dir = await resolveProjectPath(ctx, params.path, { mustExist: true });
  const st = await fs.stat(dir);
  if (!st.isDirectory()) throw new ToolError("E_PATH", "not a directory");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return {
    entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" })).sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

export async function fsRead(
  ctx: ToolContext,
  params: { path: string; max_bytes?: number },
): Promise<{ content: string; sha256: string; truncated: boolean }> {
  const max = params.max_bytes ?? FS_READ_DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > FS_READ_HARD_MAX) {
    throw new ToolError("E_PATH", `max_bytes out of range 1..${FS_READ_HARD_MAX}`);
  }
  const file = await resolveProjectPath(ctx, params.path, { mustExist: true });
  const fh = await fs.open(file, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ToolError("E_PATH", "not a file");
    if (st.nlink > 1) throw new ToolError("E_PATH_HARDLINK", "hardlinked file rejected");
    if (st.size > FS_READ_MAX_FILE_BYTES) {
      throw new ToolError("E_PATH_TOO_LARGE", `file exceeds ${FS_READ_MAX_FILE_BYTES} byte hash cap`);
    }
    // Hash the whole file, not the returned slice: sha256 is a file identity
    // that matches artifact_validate/hash --file even on a truncated read.
    const whole = await fh.readFile();
    if (whole.length > FS_READ_MAX_FILE_BYTES) {
      throw new ToolError("E_PATH_TOO_LARGE", `file exceeds ${FS_READ_MAX_FILE_BYTES} byte hash cap`);
    }
    const truncated = whole.length > max;
    const content = whole.subarray(0, truncated ? max : whole.length).toString("utf8");
    return { content, sha256: sha256Hex(whole), truncated };
  } finally {
    await fh.close();
  }
}

export async function fsWrite(
  ctx: ToolContext,
  params: { path: string; content: string },
): Promise<{ sha256: string }> {
  if (typeof params.content !== "string") throw new ToolError("E_PATH", "content must be a string");
  if (Buffer.byteLength(params.content, "utf8") > FS_WRITE_HARD_MAX) {
    throw new ToolError("E_PATH", "content exceeds 1 MiB");
  }
  // Pre-resolve for the digest target, then require approval, then re-resolve (TOCTOU).
  const pre = await resolveProjectPath(ctx, params.path);
  assertNotReserved(ctx.project, pre);
  await assertNotHardlinkedTarget(pre, params.path);
  // One lock covers approval consumption, the TOCTOU re-resolve, the atomic
  // write, and its journal entry.
  return withLock(ctx.project, async () => {
    // Fail closed before consuming the approval or touching the target: a
    // corrupt/symlinked journal must not leave an unjournaled write behind.
    const journalPreflight = await preflightJournal(ctx.project);
    await consumeApproval(ctx.project, { tool: "fs_write", target: pre, content: params.content, params: { path: params.path } });
    const target = await resolveProjectPath(ctx, params.path);
    if (target !== pre) throw new ToolError("E_PATH_ESCAPE", "target changed after approval (TOCTOU)");
    assertNotReserved(ctx.project, target);
    await assertNotHardlinkedTarget(target, params.path);
    await writeFileAtomic(target, params.content);
    const sha256 = sha256Hex(params.content);
    await appendJournal(ctx.project, ctx.journal, {
      kind: "tool_call",
      actor: ctx.actor,
      payload: { tool: "fs_write", target, sha256 },
    }, { fresh_start: journalPreflight.freshStart });
    return { sha256 };
  });
}

// ---- decision tools ----

export async function decisionGet(ctx: ToolContext, params: { id: string }): Promise<Decision> {
  const id = params.id;
  if (typeof id !== "string" || !/^D[0-9]+$/.test(id)) {
    throw new ToolError("E_PATH", `decision id must match ^D[0-9]+$: ${String(id)}`);
  }
  const file = decisionFile(ctx.project, id);
  if (path.dirname(path.resolve(file)) !== path.resolve(ctx.project.decisions)) {
    throw new ToolError("E_PATH", `decision path escapes decisions dir: ${id}`);
  }
  const d = await readDecision(ctx.project, id);
  if (d.id !== id) {
    throw new ToolError("E_SCHEMA", `decision file/id mismatch: stored ${d.id}, requested ${id}`);
  }
  return d;
}

export async function decisionUpsert(
  ctx: ToolContext,
  params: { decision: unknown; approval_id?: string },
): Promise<{ id: string; version: number; decision_hash: string }> {
  return withLock(ctx.project, async () => {
    // Preflight before acceptance approval consumption and the decision write.
    const journalPreflight = await preflightJournal(ctx.project);
    // External evidence refs are not file-verified; journal the warnings only
    // after the write succeeds so a rejected upsert leaves no state.
    const warnings: Array<{ ref: string; sha256?: string }> = [];
    const stored = await upsertDecision(ctx.project, params.decision, {
      ...(params.approval_id ? { approvalId: params.approval_id } : {}),
      gatePasses: async (gateRef) => {
        try {
          const g = await readGate(ctx.project, gateRef);
          assertGatePassable(g);
          await verifyGateApprovalProvenance(ctx.project, g);
          return true;
        } catch (err) {
          // Acceptance always reports E_GATE_BLOCKED; preserve an explicit
          // provenance/passability message, wrap gate read/validation errors.
          if (err instanceof ToolError && err.code === "E_GATE_BLOCKED") throw err;
          const e = err as { code?: string; message?: string };
          throw new ToolError(
            "E_GATE_BLOCKED",
            `gate ${gateRef}: ${e.message ?? String(err)}`,
          );
        }
      },
      approvalValid: async (approvalId, owner, decisionId, contentHash) =>
        checkAcceptApproval(ctx.project, approvalId, owner, decisionId, contentHash),
      validateArtifact: async (artifact, decisionId) => verifyAcceptedArtifact(ctx, artifact, decisionId),
      validateEvidence: async (evidence, decisionId) => verifyAcceptedEvidence(ctx, evidence, decisionId, warnings),
    });
    for (const w of warnings) {
      await appendJournal(ctx.project, ctx.journal, {
        kind: "tool_call",
        actor: ctx.actor,
        payload: {
          tool: "decision_upsert",
          warning: "evidence ref not file-verified (external)",
          decision: stored.id,
          ref: w.ref,
          sha256: w.sha256,
        },
      }, { fresh_start: journalPreflight.freshStart });
    }
    await appendJournal(ctx.project, ctx.journal, {
      kind: "tool_call",
      actor: ctx.actor,
      payload: { tool: "decision_upsert", id: stored.id, version: stored.version, status: stored.status },
    }, { fresh_start: journalPreflight.freshStart });
    return { id: stored.id, version: stored.version, decision_hash: stored.decision_hash! };
  });
}

/**
 * Acceptance artifact check: resolve under roots, require a file, hash-match,
 * a fresh validation (`validated_at` >= file mtime), an allowlisted check
 * vocabulary, and a passing validation record bound to the current hash,
 * validator version, and check-name set.
 */
async function verifyAcceptedArtifact(ctx: ToolContext, a: DecisionArtifact, decisionId: string): Promise<void> {
  let real: string;
  try {
    real = await resolveProjectPath(ctx, a.path, { mustExist: true });
  } catch (err) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' does not resolve under project roots: ${(err as Error).message}`,
    );
  }
  let actual: string;
  let mtimeMs: number;
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) throw new Error("not a regular file");
    mtimeMs = st.mtimeMs;
    actual = await hashFile(real);
  } catch (err) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' cannot be hashed: ${(err as Error).message}`,
    );
  }
  if (actual !== a.sha256) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' sha256 mismatch (recorded ${a.sha256}, actual ${actual})`,
    );
  }
  const checks = a.checks ?? [];
  for (const check of checks) {
    if (!(SUPPORTED_ARTIFACT_CHECKS as readonly string[]).includes(check)) {
      throw new ToolError(
        "E_ACCEPT_NO_ARTIFACT",
        `${decisionId}: artifact '${a.path}' has unsupported check '${check}'`,
      );
    }
  }
  const validatedMs = Date.parse(a.validated_at ?? "");
  if (Number.isNaN(validatedMs)) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' has unparseable validated_at '${a.validated_at ?? ""}'`,
    );
  }
  const mtimeFloor = Math.floor(mtimeMs);
  if (validatedMs < mtimeFloor) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' validation is stale (validated_at ${a.validated_at}, file mtime ${new Date(mtimeFloor).toISOString()}); run artifact_validate again`,
    );
  }
  const record = await findPassingValidationRecord(ctx.project.validations, {
    decisionId,
    artifactPath: a.path,
    sha256: actual,
    validatorVersion: a.validator_version,
    checks,
    mtimeFloor,
  });
  if (record === null) {
    throw new ToolError(
      "E_ACCEPT_NO_ARTIFACT",
      `${decisionId}: artifact '${a.path}' has no passing validation record for sha256 ${actual} and checks [${checks.join(", ")}]; run artifact_validate first`,
    );
  }
}

interface ValidationRecordQuery {
  decisionId: string;
  artifactPath: string;
  sha256: string;
  validatorVersion: number;
  checks: string[];
  mtimeFloor: number;
}

/** Scan `.tasteful/validations`; a malformed or non-matching record is skipped. */
async function findPassingValidationRecord(dir: string, q: ValidationRecordQuery): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const wantChecks = [...new Set(q.checks)].sort();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record;
    try {
      record = parseValidationRecord(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
    } catch {
      continue;
    }
    if (record === null) continue;
    if (record.decision_id !== q.decisionId || record.artifact_path !== q.artifactPath) continue;
    if (record.sha256 !== q.sha256 || record.validator_version !== q.validatorVersion) continue;
    const validatedMs = Date.parse(record.validated_at);
    if (Number.isNaN(validatedMs) || validatedMs < q.mtimeFloor) continue;
    const recordChecks = record.results.map((r) => r.name).sort();
    if (recordChecks.length !== wantChecks.length) continue;
    if (recordChecks.some((check, i) => check !== wantChecks[i])) continue;
    if (!record.results.every((r) => r.verdict === "pass")) continue;
    return name;
  }
  return null;
}

/**
 * Acceptance evidence check. Project-relative (and absolute-inside-project)
 * refs must exist and hash-match. URLs and absolute outside-roots refs are
 * external citations: only their recorded sha256 is required, and a warning is
 * collected for the journal.
 */
async function verifyAcceptedEvidence(
  ctx: ToolContext,
  e: Evidence,
  decisionId: string,
  warnings: Array<{ ref: string; sha256?: string }>,
): Promise<void> {
  if (!e.sha256) {
    throw new ToolError("E_ACCEPT_NO_EVIDENCE", `${decisionId}: evidence '${e.ref}' lacks sha256`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(e.ref)) {
    warnings.push({ ref: e.ref, sha256: e.sha256 });
    return;
  }
  if (path.isAbsolute(e.ref)) {
    const rootAbs = path.resolve(ctx.project.root);
    const abs = path.resolve(e.ref);
    const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
    if (!inside) {
      warnings.push({ ref: e.ref, sha256: e.sha256 });
      return;
    }
  }
  let real: string;
  try {
    real = await resolveProjectPath(ctx, e.ref, { mustExist: true });
  } catch (err) {
    throw new ToolError(
      "E_ACCEPT_NO_EVIDENCE",
      `${decisionId}: evidence '${e.ref}' does not resolve under project roots: ${(err as Error).message}`,
    );
  }
  let actual: string;
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) throw new Error("not a regular file");
    actual = await hashFile(real);
  } catch (err) {
    throw new ToolError(
      "E_ACCEPT_NO_EVIDENCE",
      `${decisionId}: evidence '${e.ref}' cannot be hashed: ${(err as Error).message}`,
    );
  }
  if (actual !== e.sha256) {
    throw new ToolError(
      "E_ACCEPT_NO_EVIDENCE",
      `${decisionId}: evidence '${e.ref}' sha256 mismatch (recorded ${e.sha256}, actual ${actual})`,
    );
  }
}

/**
 * Acceptance approvals bind tool `decision_accept`, target = decision id,
 * content_hash = the decision's canonical authored-content hash, params =
 * { approver }. The approval id must be the digest or the basename of a record
 * inside `.tasteful/approvals/`; the record is re-validated (digest, target,
 * content hash, params) and consumed single-use. Any mismatch is
 * `E_APPROVAL_MISMATCH`.
 */
export async function checkAcceptApproval(
  project: ProjectPaths,
  approvalId: string,
  owner: string,
  decisionId: string,
  submittedContentHash: string,
): Promise<boolean> {
  const { record } = await readApprovalRecord(project, approvalId);
  const approver = record.approver;
  assertNotSelf(approver, owner);
  await consumeContentBoundApproval(project, {
    tool: "decision_accept",
    target: decisionId,
    contentHash: submittedContentHash,
    params: { approver },
    approvalId,
  });
  return true;
}

export async function grantAcceptApproval(
  project: ProjectPaths,
  input: { decision_id: string; owner: string; approver: string; contentHash: string },
): Promise<{ approval_id: string; digest: string }> {
  if (!input.decision_id || !input.owner || !input.approver || !input.contentHash) {
    throw new ToolError("E_APPROVAL_DENIED", "acceptance approval needs decision, owner, approver, and content hash");
  }
  // CLI input (not authored content): NFKC+trim, domain-lowercase emails.
  const approver = canonicalIdentity(input.approver);
  assertNotSelf(approver, input.owner);
  const rec = await grantContentBoundApproval(project, {
    tool: "decision_accept",
    target: input.decision_id,
    contentHash: input.contentHash,
    params: { approver },
    approver,
  });
  return { approval_id: rec.digest, digest: rec.digest };
}

/**
 * Acceptance gate provenance: a stored `pass` gate must carry the digest of
 * the consumed `gate_accept` approval that authorized exactly this content.
 * The digest field is excluded from the gate content hash, so the record
 * granted before stamping still matches the stored gate. Any missing,
 * unresolvable, unused, retargeted, or content-mismatched record blocks
 * acceptance with E_GATE_BLOCKED (legacy/hand-written pass gates included).
 */
export async function verifyGateApprovalProvenance(project: ProjectPaths, gate: Gate): Promise<void> {
  const digest = gate.approval_digest;
  if (digest === undefined) {
    throw new ToolError(
      "E_GATE_BLOCKED",
      `gate ${gate.gate_id}: no gate approval provenance (pass gate lacks approval_digest; re-pass via gate accept + gate create --approval)`,
    );
  }
  let record;
  try {
    ({ record } = await readApprovalRecord(project, digest));
  } catch (err) {
    throw new ToolError(
      "E_GATE_BLOCKED",
      `gate ${gate.gate_id}: gate approval provenance ${digest.slice(0, 16)} does not resolve: ${(err as Error).message}`,
    );
  }
  const why =
    record.digest !== digest
      ? "approval record digest mismatch"
      : record.tool !== "gate_accept"
        ? `approval record tool is '${record.tool}', expected gate_accept`
        : record.target !== gate.gate_id
          ? `approval record target is '${record.target}', expected ${gate.gate_id}`
          : record.decision !== "granted"
            ? `approval record decision is '${record.decision ?? "missing"}'`
            : record.used !== true
              ? "approval record was never consumed by gate create"
              : !sameIdentity(record.approver, gate.approver)
                ? `approval record approver is '${record.approver}', gate approver is '${gate.approver}'`
                : record.content_hash !== computeGateContentHash(gate)
                  ? "approved gate content differs from the stored gate"
                  : undefined;
  if (why !== undefined) {
    throw new ToolError("E_GATE_BLOCKED", `gate ${gate.gate_id}: gate approval provenance does not verify: ${why}`);
  }
}

/**
 * Gate pass approvals bind tool `gate_accept`, target = gate id,
 * content_hash = canonical gate content hash, params = { approver }. Any
 * mismatch (stale gate file) is `E_APPROVAL_MISMATCH`; consumed single-use.
 * Returns the consumed record's 64-hex digest for storage in `approval_digest`.
 */
export async function checkGateApproval(
  project: ProjectPaths,
  approvalId: string,
  gate: Gate,
): Promise<string> {
  const { record } = await readApprovalRecord(project, approvalId);
  assertNotSelf(record.approver, gate.owner, "gate approver must differ from owner");
  if (!sameIdentity(record.approver, gate.approver)) {
    throw new ApprovalError(
      "E_APPROVAL_MUTATED",
      `gate approval approver '${record.approver}' differs from gate approver '${gate.approver}'`,
    );
  }
  const used = await consumeContentBoundApproval(project, {
    tool: "gate_accept",
    target: gate.gate_id,
    contentHash: computeGateContentHash(gate),
    params: { approver: record.approver },
    approvalId,
  });
  return used.digest;
}

export async function grantGateApproval(
  project: ProjectPaths,
  input: { gate_id: string; owner: string; approver: string; contentHash: string },
): Promise<{ approval_id: string; digest: string }> {
  if (!input.gate_id || !input.owner || !input.approver || !input.contentHash) {
    throw new ToolError("E_APPROVAL_DENIED", "gate approval needs gate id, owner, approver, and content hash");
  }
  // CLI input (not authored content): NFKC+trim, domain-lowercase emails.
  const approver = canonicalIdentity(input.approver);
  assertNotSelf(approver, input.owner, "gate approver must differ from owner");
  const rec = await grantContentBoundApproval(project, {
    tool: "gate_accept",
    target: input.gate_id,
    contentHash: input.contentHash,
    params: { approver },
    approver,
  });
  return { approval_id: rec.digest, digest: rec.digest };
}

export async function decisionInvalidate(
  ctx: ToolContext,
  params: { claim_id: string; old_value: string; new_value: string; reason: string; author: string; source?: string },
): Promise<{ event_id: string; affected: Record<string, string> }> {
  return withLock(ctx.project, async () => {
    // Preflight before the closure/event write; no approval is consumed here.
    const journalPreflight = await preflightJournal(ctx.project);
    const all = await readAllDecisions(ctx.project);
    // event_id: E-<date>-<nnn>. Derive from the maximum numeric suffix + 1,
    // never from the file count: a gap (restored or hand-edited bundle) would
    // otherwise make the new event overwrite an existing one.
    const day = new Date().toISOString().slice(0, 10);
    let eventNames: string[] = [];
    try {
      eventNames = await fs.readdir(ctx.project.events);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const dayPattern = new RegExp(`^E-${day}-(\\d+)\\.json$`);
    const suffixes = eventNames
      .map((name) => dayPattern.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    const next = (suffixes.length > 0 ? Math.max(...suffixes) : 0) + 1;
    const eventId = `E-${day}-${String(next).padStart(3, "0")}`;
    // Defense in depth: max+1 cannot collide under the lock, but the target
    // must never be overwritten even if this derivation is bypassed.
    const eventPath = eventFile(ctx.project, eventId);
    let eventExists = true;
    try {
      await fs.lstat(eventPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      eventExists = false;
    }
    if (eventExists) throw new ToolError("E_EVENT_EXISTS", `event already exists: ${eventId}`);
    const eventInput = {
      event_id: eventId,
      claim_id: params.claim_id,
      old_value: params.old_value,
      new_value: params.new_value,
      source: params.source ?? "scope-change",
      occurred_at: new Date().toISOString().slice(0, 10),
      reason: params.reason,
      author: params.author,
    };
    // Validate the claim/closure BEFORE persisting the event: a rejected
    // invalidation must leave no event file and no consumed event id.
    const event = validateChangeEvent(eventInput);
    const closure = computeClosure(all, event);
    const applied = applyClosure(all, closure, day);
    await writeEvent(ctx.project, eventInput);
    for (const id of Object.keys(closure.changed)) {
      await writeDecisionRecord(ctx.project, applied.get(id)!, { rebuild: false });
    }
    await rebuildIndex(ctx.project);
    await appendJournal(ctx.project, ctx.journal, {
      kind: "change_event",
      actor: ctx.actor,
      payload: { event_id: event.event_id, claim_id: event.claim_id, affected: closure.changed },
    }, { fresh_start: journalPreflight.freshStart });
    return { event_id: event.event_id, affected: closure.changed as Record<string, string> };
  });
}

// ---- artifact validation ----

export interface ArtifactValidateResult {
  ok: boolean;
  expected: string;
  actual: string;
  /** Present when the hash drifted: whether state transitions were applied. */
  drifted?: boolean;
  /** Affected decisions (owner + transitive reverse dependents), sorted. */
  affected?: string[];
  /** Executed check verdicts (absent on hash drift, which writes no record). */
  results?: ArtifactCheckResult[];
  /** Project-relative validation-record path written for this run. */
  validation_record?: string;
}

export async function artifactValidate(
  ctx: ToolContext,
  params: { decision_id: string; artifact_path: string },
): Promise<ArtifactValidateResult> {
  return withLock(ctx.project, async () => {
    // Preflight before reading/writing validation records or demoting state.
    const journalPreflight = await preflightJournal(ctx.project);
    const d = await readDecision(ctx.project, params.decision_id);
    const art = d.artifacts.find((a) => a.path === params.artifact_path);
    if (!art) throw new ToolError("E_ARTIFACT", `artifact not recorded: ${params.artifact_path}`);
    const file = await resolveProjectPath(ctx, params.artifact_path, { mustExist: true });
    const st = await fs.stat(file);
    if (!st.isFile()) throw new ToolError("E_ARTIFACT", `artifact is not a regular file: ${params.artifact_path}`);
    const actual = await hashFile(file);
    const day = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    if (actual !== art.sha256) {
      // H12: a drifted artifact cannot leave its decision accepted. Mark the
      // owner and every transitive reverse dependent needs_review, demote any
      // accepted status to proposed, and clear ready on all their artifacts.
      // Drift writes no validation record: there is nothing valid to record.
      const all = await readAllDecisions(ctx.project);
      const affected = collectReverseDependents(all, [d.id]);
      for (const id of affected) {
        const cur = all.get(id)!;
        const isDriftedOwner = id === d.id;
        const artifacts = cur.artifacts.map((a) =>
          isDriftedOwner && a.path === art.path
            ? { ...a, ready: false, validated_at: now, checks: ["sha256"] }
            : { ...a, ready: false },
        );
        await writeDecisionRecord(
          ctx.project,
          {
            ...cur,
            status: cur.status === "accepted" ? "proposed" : cur.status,
            review_state: "needs_review",
            updated_at: day,
            artifacts,
          },
          { rebuild: false },
        );
      }
      await rebuildIndex(ctx.project);
      await appendJournal(ctx.project, ctx.journal, {
        kind: "tool_call",
        actor: ctx.actor,
        payload: {
          tool: "artifact_validate",
          decision: d.id,
          path: params.artifact_path,
          ok: false,
          drifted: true,
          affected,
          note: "drift: affected decisions -> needs_review, accepted -> proposed, artifacts ready=false",
        },
      }, { fresh_start: journalPreflight.freshStart });
      return { ok: false, expected: art.sha256, actual, drifted: true, affected };
    }

    const results = await runArtifactChecks(file, art.checks ?? [], {
      projectRoot: ctx.project.root,
      exportsDir: ctx.project.exports,
    });
    const allPass = results.length > 0 && results.every((r) => r.verdict === "pass");
    const record = {
      schema_version: VALIDATION_RECORD_SCHEMA_VERSION,
      decision_id: d.id,
      artifact_path: art.path,
      sha256: actual,
      validator_version: art.validator_version,
      results,
      validated_at: now,
      artifact_mtime_ms: Math.floor(st.mtimeMs),
    };
    const recordPath = path.join(ctx.project.validations, validationRecordName(d.id, art.path, actual));
    await fs.mkdir(ctx.project.validations, { recursive: true });
    await writeFileAtomic(recordPath, canonicalJson(record) + "\n");
    const recordRel = path.relative(ctx.project.root, recordPath);
    const checked = results.map((r) => r.name);

    if (allPass) {
      const artifacts = d.artifacts.map((a) =>
        a.path === art.path ? { ...a, validated_at: now, checks: checked, ready: true } : a,
      );
      await writeDecisionRecord(ctx.project, { ...d, artifacts }, { rebuild: false });
      await rebuildIndex(ctx.project);
      await appendJournal(ctx.project, ctx.journal, {
        kind: "tool_call",
        actor: ctx.actor,
        payload: {
          tool: "artifact_validate",
          decision: d.id,
          path: params.artifact_path,
          ok: true,
          checks: results,
          validation_record: recordRel,
        },
      }, { fresh_start: journalPreflight.freshStart });
      return { ok: true, expected: art.sha256, actual, results, validation_record: recordRel };
    }

    // Failed or empty checks cannot leave a decision current: apply the same
    // demotion/propagation as drift, with reason checks-failed.
    const all = await readAllDecisions(ctx.project);
    const affected = collectReverseDependents(all, [d.id]);
    for (const id of affected) {
      const cur = all.get(id)!;
      const isOwner = id === d.id;
      const artifacts = cur.artifacts.map((a) =>
        isOwner && a.path === art.path
          ? { ...a, ready: false, validated_at: now, checks: checked }
          : { ...a, ready: false },
      );
      await writeDecisionRecord(
        ctx.project,
        {
          ...cur,
          status: cur.status === "accepted" ? "proposed" : cur.status,
          review_state: "needs_review",
          updated_at: day,
          artifacts,
        },
        { rebuild: false },
      );
    }
    await rebuildIndex(ctx.project);
    await appendJournal(ctx.project, ctx.journal, {
      kind: "tool_call",
      actor: ctx.actor,
      payload: {
        tool: "artifact_validate",
        decision: d.id,
        path: params.artifact_path,
        ok: false,
        reason: "checks-failed",
        checks: results,
        validation_record: recordRel,
        affected,
        note: "checks-failed: affected decisions -> needs_review, accepted -> proposed, artifacts ready=false",
      },
    }, { fresh_start: journalPreflight.freshStart });
    return { ok: false, expected: art.sha256, actual, results, validation_record: recordRel, affected };
  });
}

// ---- gate tools ----

export async function gateGet(ctx: ToolContext, params: { gate_id: string }): Promise<Gate> {
  const gateId = params.gate_id;
  if (typeof gateId !== "string" || !/^G-[A-Z0-9-]+$/.test(gateId)) {
    throw new ToolError("E_PATH", `gate id must match ^G-[A-Z0-9-]+$: ${String(gateId)}`);
  }
  const file = gateFile(ctx.project, gateId);
  if (path.dirname(path.resolve(file)) !== path.resolve(ctx.project.gates)) {
    throw new ToolError("E_PATH", `gate path escapes gates dir: ${gateId}`);
  }
  // readGate binds the file name to the declared gate_id (E_SCHEMA on mismatch).
  return readGate(ctx.project, gateId);
}

export interface GateUpsertOptions {
  /**
   * Internal only: the human `gate revoke` transition writes the revoked
   * record through gateUpsert. Authored gate create/upsert never sets this.
   */
  allowRevoke?: boolean;
}

export async function gateUpsert(
  ctx: ToolContext,
  params: { gate: unknown; approval_id?: string },
  opts?: GateUpsertOptions,
): Promise<{ gate_id: string }> {
  return withLock(ctx.project, () => gateUpsertLocked(ctx, params, opts));
}

async function gateUpsertLocked(
  ctx: ToolContext,
  params: { gate: unknown; approval_id?: string },
  opts?: GateUpsertOptions,
): Promise<{ gate_id: string }> {
  // Preflight before any validation/approval consumption/gate write. Also runs
  // on the gateRevoke path (after its own preflight) through this function.
  const journalPreflight = await preflightJournal(ctx.project);
  // approval_digest is provenance stamped by the human pass path, never input.
  if (!opts?.allowRevoke && isRecord(params.gate) && "approval_digest" in params.gate) {
    throw new ToolError(
      "E_SCHEMA",
      "gate.approval_digest is system-derived; a human pass gets it from gate create --approval",
    );
  }
  const g = validateGate(params.gate);
  if (g.decision === "revoked" && !opts?.allowRevoke) {
    throw new ToolError("E_GATE_HUMAN_ONLY", `gate ${g.gate_id}: 'revoked' is only writable via \`gate revoke\``);
  }
  let existing: Gate | undefined;
  try {
    existing = await readGate(ctx.project, g.gate_id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (ctx.actor === "agent") {
    if (g.decision === "pass") {
      throw new ToolError("E_GATE_HUMAN_ONLY", `gate ${g.gate_id}: a model cannot pass a gate`);
    }
    // A stored human pass is immutable to the model: no pending/fail downgrade
    // (or any other write) may erase the gate an accepted decision cites.
    if (existing?.decision === "pass") {
      throw new ToolError("E_GATE_HUMAN_ONLY", `gate ${g.gate_id}: a model cannot modify a passed gate`);
    }
  }
  // A stored human pass is a durable record: even a human cannot downgrade it
  // through authored gate JSON. The only path out of `pass` is `gate revoke`
  // (which sets `revoked`, demotes dependents, and journals the transition).
  if (existing?.decision === "pass" && g.decision !== "pass" && !opts?.allowRevoke) {
    throw new ToolError(
      "E_GATE_HUMAN_ONLY",
      `gate ${g.gate_id}: a stored pass cannot be changed to '${g.decision}'; use gate revoke`,
    );
  }
  // Validate passability BEFORE persisting: a rejected gate must leave no file.
  let approvalDigest: string | undefined;
  if (g.decision === "pass") {
    assertGatePassable(g);
    if (ctx.actor === "human") {
      // A human pass must be bound to this exact gate content and consumed
      // once; a changed gate file is E_APPROVAL_MISMATCH. The consumed digest
      // becomes durable provenance for decision acceptance.
      if (!params.approval_id) {
        throw new ToolError("E_GATE_NO_APPROVAL", `gate ${g.gate_id}: a passing gate requires --approval`);
      }
      approvalDigest = await checkGateApproval(ctx.project, params.approval_id, g);
    }
  }
  const storedGate =
    approvalDigest !== undefined
      ? validateGate({ ...g, approval_digest: approvalDigest })
      : g;
  const written = await writeGate(ctx.project, storedGate);
  await appendJournal(ctx.project, ctx.journal, {
    kind: "gate",
    actor: ctx.actor,
    payload: { gate_id: written.gate_id, decision: written.decision },
  }, { fresh_start: journalPreflight.freshStart });
  return { gate_id: written.gate_id };
}

export interface GateRevokeResult {
  gate_id: string;
  /** Accepted decisions demoted to proposed/needs_review (sorted). */
  demoted: string[];
}

/**
 * Human-only gate revoke (CLI `gate revoke`; no model tool). Requires a
 * stored pass gate and an approver different from the owner, sets `revoked`,
 * and demotes every accepted decision citing the gate. The caller-level lock
 * covers the gate write, the demotions, and the journal event.
 */
export async function gateRevoke(
  ctx: ToolContext,
  params: { gate_id: string; approver: string },
): Promise<GateRevokeResult> {
  if (ctx.actor !== "human") {
    throw new ToolError("E_GATE_HUMAN_ONLY", "gate revoke is a human-only transition");
  }
  const gateId = params.gate_id;
  if (typeof gateId !== "string" || !/^G-[A-Z0-9-]+$/.test(gateId)) {
    throw new ToolError("E_PATH", `gate id must match ^G-[A-Z0-9-]+$: ${String(gateId)}`);
  }
  if (typeof params.approver !== "string" || params.approver.length === 0) {
    throw new ToolError("E_GATE_BLOCKED", "gate revoke requires an approver");
  }
  const approver = canonicalIdentity(params.approver);
  return withLock(ctx.project, async () => {
    // Preflight before demoting dependents or flipping the gate.
    const journalPreflight = await preflightJournal(ctx.project);
    let existing: Gate;
    try {
      existing = await readGate(ctx.project, gateId);
    } catch (err) {
      throw new ToolError("E_GATE_BLOCKED", `gate ${gateId}: cannot revoke: ${(err as Error).message}`);
    }
    if (existing.decision !== "pass") {
      throw new ToolError(
        "E_GATE_BLOCKED",
        `gate ${gateId}: only a pass gate can be revoked (decision is '${existing.decision}')`,
      );
    }
    assertNotSelf(approver, existing.owner, `gate ${gateId}: approver == owner`);
    // Demote dependents before the gate flips, so a crash cannot leave an
    // accepted decision citing a revoked gate.
    const demoted = await demoteGateDependents(ctx.project, gateId);
    await gateUpsertLocked(
      ctx,
      { gate: { ...existing, decision: "revoked" } },
      { allowRevoke: true },
    );
    await appendJournal(ctx.project, ctx.journal, {
      kind: "gate",
      actor: "human",
      payload: { event: "gate_revoke", gate_id: gateId, approver, demoted },
    }, { fresh_start: journalPreflight.freshStart });
    return { gate_id: gateId, demoted };
  });
}

// ---- artcraft tools ----

export async function artcraftInfo(
  ctx: ToolContext,
  params: { file: string },
  exe?: string,
): Promise<{ info: unknown }> {
  const file = await resolveProjectPath(ctx, params.file, { mustExist: true });
  // info reads: file may live outside the project (e.g. shared BRIM source).
  // The tool resolves inside roots; CLI-level export/info on external files
  // goes through runArtcraftInfoExternal. For MVP simplicity the model path
  // stays inside roots; the CLI path allows an explicit external source root.
  const res = await figcraftInfo(file, ctx.roots, exe);
  await journalAdapterRun(ctx.project, ctx.journal, ctx.actor, {
    tool: "artcraft_info",
    pair: res.pair,
    argv: res.argv,
    exitCode: res.exitCode,
    roots: { read: ctx.roots.read, write: [] },
    extra: { file },
  });
  return { info: res.info };
}

/** CLI/deterministic path: info on a file with explicit read roots (source stays read-only). */
export async function runArtcraftInfoExternal(
  ctx: ToolContext,
  params: { file: string; read_roots: string[] },
  exe?: string,
): Promise<{ info: unknown; argv: string[] }> {
  for (const r of params.read_roots) {
    const st = await fs.stat(r);
    if (!st.isDirectory()) throw new ToolError("E_PATH", `read root not a dir: ${r}`);
  }
  const res = await figcraftInfo(params.file, { read: params.read_roots, write: [] }, exe);
  await journalAdapterRun(ctx.project, ctx.journal, ctx.actor, {
    tool: "artcraft_info",
    pair: res.pair,
    argv: res.argv,
    exitCode: res.exitCode,
    roots: { read: params.read_roots, write: [] },
    extra: { file: params.file },
  });
  return { info: res.info, argv: res.argv };
}

export async function artcraftExport(
  ctx: ToolContext,
  params: { file: string; out: string; node?: string; format?: string; page?: string; scale?: string },
  exe?: string,
): Promise<{ out: string; files: string[]; sha256: Record<string, string> }> {
  const pre = await resolveProjectPath(ctx, params.out);
  assertNotReserved(ctx.project, pre);
  const argvJson = JSON.stringify({ file: params.file, out: pre, node: params.node, format: params.format, page: params.page, scale: params.scale });
  await withLock(ctx.project, async () => {
    await consumeApproval(ctx.project, { tool: "artcraft_export", target: pre, content: argvJson, params: { file: params.file } });
  });
  const target = await resolveProjectPath(ctx, params.out);
  if (target !== pre) throw new ToolError("E_PATH_ESCAPE", "export target changed after approval (TOCTOU)");
  assertNotReserved(ctx.project, target);
  // Source must resolve inside roots for the model path.
  const file = await resolveProjectPath(ctx, params.file, { mustExist: true });
  const res = await figcraftExport({ ...params, file, out: target }, ctx.roots, exe);
  const hashes: Record<string, string> = {};
  for (const f of res.files) hashes[f] = await hashFile(f);
  await journalAdapterRun(ctx.project, ctx.journal, ctx.actor, {
    tool: "artcraft_export",
    pair: res.pair,
    argv: res.argv,
    exitCode: res.exitCode,
    roots: { read: ctx.roots.read, write: ctx.roots.write },
    stderrTail: res.stderrTail,
    extra: { files: res.files, sha256: hashes },
  });
  return { out: target, files: res.files, sha256: hashes };
}

/** CLI/deterministic path: export from an external read-only source into the project exports root. */
export async function runArtcraftExportExternal(
  ctx: ToolContext,
  params: { file: string; out: string; node?: string; format?: string; read_roots: string[] },
  exe?: string,
): Promise<{ out: string; files: string[]; sha256: Record<string, string>; argv: string[] }> {
  const out = await resolveProjectPath(ctx, params.out);
  assertNotReserved(ctx.project, out);
  const res = await figcraftExport(
    { file: params.file, out, node: params.node, format: params.format },
    { read: params.read_roots, write: [ctx.project.exports] },
    exe,
  );
  const hashes: Record<string, string> = {};
  for (const f of res.files) hashes[f] = await hashFile(f);
  await journalAdapterRun(ctx.project, ctx.journal, ctx.actor, {
    tool: "artcraft_export",
    pair: res.pair,
    argv: res.argv,
    exitCode: res.exitCode,
    roots: { read: params.read_roots, write: [ctx.project.exports] },
    stderrTail: res.stderrTail,
    extra: { files: res.files, sha256: hashes },
  });
  return { out, files: res.files, sha256: hashes, argv: res.argv };
}

export async function runAdapterCheck(
  ctx: ToolContext,
  params: { canary?: string },
  exe?: string,
): Promise<Handshake> {
  const h = await adapterCheck(exe, params.canary);
  await journalAdapterRun(ctx.project, ctx.journal, ctx.actor, {
    tool: "adapter_check",
    pair: h,
    argv: params.canary ? buildCanaryInfoArgv(params.canary) : [h.exePath, "--version"],
    exitCode: 0,
    roots: {
      read: params.canary ? [path.dirname(path.resolve(params.canary))] : [],
      write: [],
    },
    extra: {
      canary: h.canary,
      canaryOk: h.canaryOk,
      ...(h.canaryHash ? { canaryHash: h.canaryHash } : {}),
    },
  });
  return h;
}

// ---- journal read ----

export async function runJournalRead(
  ctx: ToolContext,
  params: { seq_from?: number; limit?: number },
): Promise<{ entries: unknown[]; ok: boolean }> {
  let all;
  try {
    all = await verifyJournal(ctx.project);
  } catch (err) {
    throw new ToolError("E_JOURNAL_CORRUPT", `journal verification failed: ${(err as Error).message}`);
  }
  const from = params.seq_from ?? 1;
  const limit = Math.max(0, Math.min(params.limit ?? 200, 1000));
  return { entries: all.filter((e) => e.seq >= from).slice(0, limit), ok: true };
}

export const PRODUCT_TOOL_NAMES = [
  "fs_list",
  "fs_read",
  "fs_write",
  "decision_get",
  "decision_upsert",
  "decision_invalidate",
  "artifact_validate",
  "artcraft_info",
  "artcraft_export",
  "gate_get",
  "gate_upsert",
  "run_journal_read",
] as const;

export { gateFile, eventFile };
export type { ChangeEvent };
