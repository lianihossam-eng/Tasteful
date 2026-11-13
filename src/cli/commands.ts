/** CLI command implementations. All commands run deterministically (no LLM). */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalJson, computeAuthoredContentHash, computeGateContentHash, hashFile, sha256Hex } from "../design/hashes.js";
import { SchemaError, validateCoverage, validateDecision, validateGate, type Decision, type Gate } from "../design/schema.js";
import { canonicalIdentity } from "../design/identity.js";
import {
  initProject,
  listDecisionIds,
  projectPaths,
  readDecision,
  readGate,
  withLock,
  writeFileAtomic,
  assertStateRoots,
} from "../design/store.js";
import { grantApproval, denyApproval, listPendingApprovals } from "../host/approvals.js";
import { appendJournal, preflightJournal, verifyJournal, type JournalContext } from "../host/journal.js";
import {
  artifactValidate,
  artcraftExport,
  assertNotReserved,
  decisionGet,
  decisionInvalidate,
  decisionUpsert,
  fsRead,
  fsWrite,
  gateGet,
  gateRevoke,
  gateUpsert,
  grantAcceptApproval,
  grantGateApproval,
  makeToolContext,
  resolveProjectPath,
  runAdapterCheck,
  runArtcraftExportExternal,
  runArtcraftInfoExternal,
  type ToolContext,
} from "../host/tools.js";
import { checkCoverage } from "../workflow/coverage.js";
import { figcraftInfo } from "../artcraft/figcraft.js";
import { journalAdapterRun } from "../artcraft/matrix.js";
import { TASTEFUL_VERSION } from "./identity.js";
import { PI_VERSION } from "../version.js";

export { PI_VERSION };

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(code: string, message: string, exitCode = 3) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface GlobalOpts {
  project: string;
}

export function journalContextFor(tc: ToolContext): JournalContext {
  return tc.journal;
}

export function makeCtx(projectRoot: string, actor: "agent" | "human" = "human"): ToolContext {
  return makeToolContext(
    projectRoot,
    {
      tastefulVersion: TASTEFUL_VERSION,
      piVersion: PI_VERSION,
      roots: { project: projectRoot, exports: path.join(projectRoot, ".tasteful", "exports") },
    },
    actor,
  );
}

function mapError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const e = err as { code?: string; message?: string; name?: string };
  const code = e?.code ?? "E_UNKNOWN";
  const message = e?.message ?? String(err);
  if (code === "E_PATH_ESCAPE" || code === "E_NOT_ALLOWLISTED" || code === "E_PATH_RESERVED" ||
      code === "E_PATH_HARDLINK" || code === "E_PATH_SYMLINK") {
    return new CliError(code, message, 4);
  }
  if (code === "E_UNSUPPORTED_PAIR") return new CliError(code, message, 5);
  if (code === "E_LOCK_BUSY") return new CliError(code, message, 6);
  if (code === "E_SCHEMA" || code === "E_GATE_BLOCKED" || code === "E_SELF_APPROVAL" ||
      code === "E_CYCLE" || code === "E_DEP_MISSING" || code.startsWith("E_ACCEPT") ||
      code === "E_CLAIM_UNKNOWN" || code === "E_APPROVAL_DENIED" || code === "E_APPROVAL_REPLAY" ||
      code === "E_APPROVAL_MUTATED" || code === "E_APPROVAL_MISMATCH" || code === "E_APPROVAL_PATH" ||
      code === "E_GATE_NO_APPROVAL" || code === "E_ARTIFACT" ||
      code === "E_PATH" || code === "E_GATE_HUMAN_ONLY" || code === "E_JOURNAL_CORRUPT" ||
      code === "E_EVENT_EXISTS" ||
      code === "E_ADAPTER_COMMAND" || code === "E_ADAPTER_VALIDATION") {
    return new CliError(code, message, 3);
  }
  if ((err as Error)?.name === "SchemaError") return new CliError("E_SCHEMA", message, 3);
  return new CliError(code, message, 3);
}

export async function cmdInit(g: GlobalOpts, name?: string): Promise<string> {
  try {
    const p = await initProject(g.project, name ?? path.basename(g.project), TASTEFUL_VERSION);
    const tc = makeCtx(g.project);
    await withLock(p, async () => {
      await appendJournal(p, tc.journal, { kind: "command", actor: "human", payload: { command: "init" } });
    });
    return `initialized ${p.tasteful}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdBrief(g: GlobalOpts, briefFile: string, coverageFile: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const brief = await fs.readFile(briefFile, "utf8");
    if (brief.length > 1024 * 1024) throw new SchemaError("brief too large");
    const coverageRaw = JSON.parse(await fs.readFile(coverageFile, "utf8")) as unknown;
    const { matrix, warnings } = checkCoverage(validateCoverage(coverageRaw));
    await withLock(tc.project, async () => {
      // Preflight before writing brief.md/coverage.json so a corrupt journal
      // cannot leave unjournaled state behind.
      await preflightJournal(tc.project);
      await writeFileAtomic(path.join(tc.project.tasteful, "brief.md"), brief);
      await writeFileAtomic(path.join(tc.project.tasteful, "coverage.json"), canonicalJson(matrix) + "\n");
      await appendJournal(tc.project, tc.journal, {
        kind: "command",
        actor: "human",
        payload: { command: "brief", brief_sha256: sha256Hex(brief), brief_id: matrix.brief_id },
      });
    });
    return `brief ingested (${matrix.brief_id}, ${matrix.screens.length} screens)${warnings.length > 0 ? `\nwarnings:\n- ${warnings.join("\n- ")}` : ""}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdDecisionCreate(g: GlobalOpts, file: string, approval?: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const res = await decisionUpsert(tc, { decision: raw, ...(approval ? { approval_id: approval } : {}) });
    return `${res.id} v${res.version} ${res.decision_hash}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdDecisionGet(g: GlobalOpts, id: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    return canonicalJson(await decisionGet(tc, { id })) + "\n";
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdDecisionList(g: GlobalOpts): Promise<string> {
  try {
    const p = projectPaths(g.project);
    const lines: string[] = [];
    for (const id of await listDecisionIds(p)) {
      const d = await readDecision(p, id);
      lines.push(`${d.id} ${d.status} ${d.review_state ?? "current"} v${d.version} ${d.title}`);
    }
    return (lines.length > 0 ? lines.join("\n") + "\n" : "no decisions\n");
  } catch (err) {
    throw mapError(err);
  }
}

export interface InvalidateArgs {
  claim: string;
  old: string;
  newValue: string;
  reason: string;
  author: string;
}

export async function cmdInvalidate(g: GlobalOpts, a: InvalidateArgs): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const res = await decisionInvalidate(tc, {
      claim_id: a.claim,
      old_value: a.old,
      new_value: a.newValue,
      reason: a.reason,
      author: a.author,
    });
    const lines = Object.entries(res.affected).map(([id, st]) => `${id} ${st}`);
    return `${res.event_id}\n${lines.join("\n")}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdGateCreate(g: GlobalOpts, file: string, approval?: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    const res = await gateUpsert(tc, { gate: raw, ...(approval ? { approval_id: approval } : {}) });
    return `${res.gate_id}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export interface GateSelection {
  id?: string;
  file?: string;
}

/**
 * Grant a human gate-pass approval bound to the exact gate content. `--id`
 * binds the current stored gate; `--file` binds the given authored gate JSON
 * (used for the first pass, before the gate can be persisted).
 */
export async function cmdGateAccept(g: GlobalOpts, selection: GateSelection, approver: string): Promise<string> {
  try {
    if ((selection.id === undefined) === (selection.file === undefined)) {
      throw new CliError("E_USAGE", "gate accept needs exactly one of --id <G> or --file <json>", 2);
    }
    // CLI approval input, not authored gate content: normalize before use.
    const canonicalApprover = canonicalIdentity(approver);
    const tc = makeCtx(g.project);
    let gate: Gate;
    if (selection.id !== undefined) {
      gate = await readGate(tc.project, selection.id);
    } else {
      const raw = JSON.parse(await fs.readFile(selection.file!, "utf8")) as unknown;
      gate = validateGate(raw);
    }
    const rec = await withLock(tc.project, async () => {
      const r = await grantGateApproval(tc.project, {
        gate_id: gate.gate_id,
        owner: gate.owner,
        approver: canonicalApprover,
        contentHash: computeGateContentHash(gate),
      });
      await appendJournal(tc.project, tc.journal, {
        kind: "approval",
        actor: "human",
        payload: { tool: "gate_accept", gate_id: gate.gate_id, approver: canonicalApprover, digest: r.digest },
      });
      return r;
    });
    return `${rec.approval_id}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdGateGet(g: GlobalOpts, id: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    return canonicalJson(await gateGet(tc, { gate_id: id })) + "\n";
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Human-only revoke: a pass gate becomes non-pass (`revoked`) and every
 * accepted decision citing it is demoted (proposed/needs_review, artifacts
 * not ready). Re-acceptance requires re-passing the gate with a fresh
 * `gate_accept` approval, then a fresh `decision_accept` approval.
 */
export async function cmdGateRevoke(g: GlobalOpts, id: string, approver: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const res = await gateRevoke(tc, { gate_id: id, approver: canonicalIdentity(approver) });
    const demoted = res.demoted.length > 0 ? ` demoted=${res.demoted.join(",")}` : "";
    return `${res.gate_id} revoked${demoted}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdValidate(g: GlobalOpts, decision: string, artifact: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const res = await artifactValidate(tc, { decision_id: decision, artifact_path: artifact });
    if (res.ok) return `OK ${decision} ${artifact}: ${res.actual}\n`;
    const affected = res.affected && res.affected.length > 0 ? res.affected.join(",") : decision;
    if (res.drifted) {
      return `DRIFT ${decision} ${artifact}: expected=${res.expected} actual=${res.actual} affected=${affected}\n`;
    }
    const details = (res.results ?? [])
      .map((r) => `${r.name}=${r.verdict}${r.verdict === "fail" ? `(${r.detail})` : ""}`)
      .join(" ");
    throw new CliError(
      "E_ARTIFACT_CHECKS",
      `CHECKS-FAILED ${decision} ${artifact}: ${details || "no checks recorded"}; affected=${affected}`,
      3,
    );
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdAdapterCheck(g: GlobalOpts, canary?: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const h = await runAdapterCheck(tc, { ...(canary ? { canary } : {}) });
    const hashSuffix = h.canaryHash ? ` canary_hash=${h.canaryHash}` : "";
    return `cli=${h.cliVersion} app=${h.appVersion} commands=${h.commandsHash.slice(0, 16)} canary=${h.canaryOk}${hashSuffix}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export interface ExportArgs {
  file: string;
  out: string;
  node?: string;
  format?: string;
}

export async function cmdExport(g: GlobalOpts, a: ExportArgs): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    // If the source is inside the project, use the approval-gated tool path.
    // External read-only sources (e.g. shared BRIM file) go through the
    // external path with explicit read roots; the file itself is never written.
    let res: { files: string[]; sha256: Record<string, string>; argv: string[] };
    try {
      await resolveProjectPath(tc, a.file, { mustExist: true });
      const target = await resolveProjectPath(tc, a.out);
      assertNotReserved(tc.project, target);
      await withLock(tc.project, async () => {
        await grantApproval(tc.project, {
          tool: "artcraft_export",
          target,
          content: JSON.stringify({ file: a.file, out: target, node: a.node, format: a.format }),
          params: { file: a.file },
          approver: "operator@tasteful",
        });
      });
      const r = await artcraftExport(tc, { file: a.file, out: a.out, ...(a.node ? { node: a.node } : {}), ...(a.format ? { format: a.format } : {}) });
      res = { files: r.files, sha256: r.sha256, argv: [] };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "E_PATH_ESCAPE" || code === "E_PATH") {
        // External source: read-only, explicit read root = its directory.
        const abs = path.isAbsolute(a.file) ? a.file : path.resolve(a.file);
        await fs.stat(abs);
        const r = await runArtcraftExportExternal(tc, {
          file: abs,
          out: a.out,
          ...(a.node ? { node: a.node } : {}),
          ...(a.format ? { format: a.format } : {}),
          read_roots: [path.dirname(abs)],
        });
        res = r;
      } else {
        throw err;
      }
    }
    const lines = res.files.map((f) => `${f} ${res.sha256[f]}`);
    return lines.join("\n") + "\n";
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdInfo(g: GlobalOpts, file: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    try {
      const abs = await resolveProjectPath(tc, file, { mustExist: true });
      const res = await figcraftInfo(abs, tc.roots);
      await journalAdapterRun(tc.project, tc.journal, tc.actor, {
        tool: "artcraft_info",
        pair: res.pair,
        argv: res.argv,
        exitCode: res.exitCode,
        roots: { read: tc.roots.read, write: [] },
        extra: { file: abs },
      });
      return canonicalJson(res.info) + "\n";
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "E_PATH_ESCAPE" || code === "E_PATH") {
        const abs = path.isAbsolute(file) ? file : path.resolve(file);
        await fs.stat(abs);
        const r = await runArtcraftInfoExternal(tc, { file: abs, read_roots: [path.dirname(abs)] });
        return canonicalJson(r.info) + "\n";
      }
      throw err;
    }
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdApproveList(g: GlobalOpts): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const pending = await listPendingApprovals(tc.project);
    if (pending.length === 0) return "no pending approvals\n";
    return pending.map((r) => `${r.digest.slice(0, 16)} ${r.tool} ${r.target} by=${r.approver}`).join("\n") + "\n";
  } catch (err) {
    throw mapError(err);
  }
}

export interface ApprovalInput {
  tool: string;
  target: string;
  content: string;
  params: unknown;
  approver: string;
}

function assertApprovalInput(input: ApprovalInput): void {
  if (typeof input.tool !== "string" || input.tool.length === 0 || input.tool.length > 120) {
    throw new CliError("E_USAGE", "approval --tool must be a non-empty string (<=120)", 2);
  }
  if (typeof input.target !== "string" || input.target.length === 0 || input.target.length > 1024) {
    throw new CliError("E_USAGE", "approval --target must be a non-empty string (<=1024)", 2);
  }
  if (typeof input.content !== "string") {
    throw new CliError("E_USAGE", "approval content must be a string", 2);
  }
  if (typeof input.approver !== "string" || input.approver.length === 0 || input.approver.length > 200) {
    throw new CliError("E_USAGE", "approval --approver must be a non-empty email/id (<=200)", 2);
  }
  try {
    canonicalJson(input.params ?? null);
  } catch {
    throw new CliError("E_USAGE", "approval --params-json must be JSON-serializable", 2);
  }
  if (input.tool === "decision_accept" && input.approver === input.content) {
    throw new CliError("E_SELF_APPROVAL", "decision_accept: approver must differ from owner", 3);
  }
}

export async function cmdApproveGrant(g: GlobalOpts, input: ApprovalInput): Promise<string> {
  try {
    assertApprovalInput(input);
    const normalized = { ...input, approver: canonicalIdentity(input.approver) };
    const tc = makeCtx(g.project);
    const rec = await withLock(tc.project, async () => {
      const r = await grantApproval(tc.project, normalized);
      await appendJournal(tc.project, tc.journal, {
        kind: "approval",
        actor: "human",
        payload: { digest: r.digest, tool: r.tool, target: r.target, decision: "granted" },
      });
      return r;
    });
    return `${rec.digest}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdApproveDeny(g: GlobalOpts, input: ApprovalInput): Promise<string> {
  try {
    assertApprovalInput(input);
    const normalized = { ...input, approver: canonicalIdentity(input.approver) };
    const tc = makeCtx(g.project);
    const rec = await withLock(tc.project, async () => {
      const r = await denyApproval(tc.project, normalized);
      await appendJournal(tc.project, tc.journal, {
        kind: "approval",
        actor: "human",
        payload: { digest: r.digest, tool: r.tool, target: r.target, decision: "denied" },
      });
      return r;
    });
    return `${rec.digest}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export interface AcceptSelection {
  decision?: string;
  file?: string;
}

/**
 * Record a human acceptance approval bound to the exact decision content.
 * `--decision` reads the current stored decision (hash-verified); `--file`
 * binds the given authored decision JSON. The approval record binds the
 * canonical authored-content hash (not the owner), so any later content edit
 * makes `decision create --approval` fail with E_APPROVAL_MISMATCH.
 */
export async function cmdAccept(g: GlobalOpts, selection: AcceptSelection, approver: string): Promise<string> {
  try {
    if ((selection.decision === undefined) === (selection.file === undefined)) {
      throw new CliError("E_USAGE", "accept needs exactly one of --decision <D> or --file <json>", 2);
    }
    // CLI approval input, not authored decision content: normalize before use.
    const canonicalApprover = canonicalIdentity(approver);
    const tc = makeCtx(g.project);
    let decision: Decision;
    if (selection.decision !== undefined) {
      decision = await readDecision(tc.project, selection.decision);
    } else {
      const raw = JSON.parse(await fs.readFile(selection.file!, "utf8")) as unknown;
      decision = validateDecision(raw);
    }
    const contentHash = computeAuthoredContentHash(decision);
    const rec = await withLock(tc.project, async () => {
      const r = await grantAcceptApproval(tc.project, {
        decision_id: decision.id,
        owner: decision.owner,
        approver: canonicalApprover,
        contentHash,
      });
      await appendJournal(tc.project, tc.journal, {
        kind: "approval",
        actor: "human",
        payload: {
          tool: "decision_accept",
          decision: decision.id,
          approver: canonicalApprover,
          digest: r.digest,
          content_hash: contentHash,
        },
      });
      return r;
    });
    return `${rec.approval_id}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdFsWrite(g: GlobalOpts, file: string, content: string, approver: string): Promise<string> {
  // Operator helper used by scripts/e2e: grant + write in one human step.
  try {
    const tc = makeCtx(g.project);
    const target = await resolveProjectPath(tc, file);
    assertNotReserved(tc.project, target);
    const canonicalApprover = canonicalIdentity(approver);
    await withLock(tc.project, async () => {
      await grantApproval(tc.project, { tool: "fs_write", target, content, params: { path: file }, approver: canonicalApprover });
    });
    const res = await fsWrite(tc, { path: file, content });
    return `${res.sha256}\n`;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdFsRead(g: GlobalOpts, file: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const res = await fsRead(tc, { path: file });
    return res.content;
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdStatus(g: GlobalOpts, json: boolean): Promise<string> {
  try {
    const p = projectPaths(g.project);
    await assertStateRoots(p);
    const ids = await listDecisionIds(p);
    const decisions = [];
    for (const id of ids) {
      const d = await readDecision(p, id);
      decisions.push({
        id: d.id,
        status: d.status,
        review_state: d.review_state ?? "current",
        version: d.version,
        artifacts: d.artifacts.map((a) => ({ path: a.path, ready: a.ready ?? true })),
      });
    }
    const gates: Array<{ gate_id: string; decision: string }> = [];
    const gateErrors: Array<{ file: string; error: string }> = [];
    let gateEntries: string[] = [];
    try {
      gateEntries = await fs.readdir(p.gates);
    } catch (err) {
      // Only a missing gates dir means "no gates". Any other readdir failure
      // (and every per-gate read failure below) is surfaced, never swallowed.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        gateErrors.push({ file: p.gates, error: (err as Error).message ?? String(err) });
      }
    }
    for (const e of gateEntries.filter((x) => x.endsWith(".json")).sort()) {
      try {
        const gt = await readGate(p, e.slice(0, -5));
        gates.push({ gate_id: gt.gate_id, decision: gt.decision });
      } catch (err) {
        gateErrors.push({ file: e, error: (err as Error).message ?? String(err) });
      }
    }
    let journalSeq = -1;
    let journalOk = true;
    let journalError: string | undefined;
    try {
      journalSeq = (await verifyJournal(p)).length;
    } catch (err) {
      journalOk = false;
      journalError = (err as Error).message ?? String(err);
    }
    const status = {
      project: g.project,
      tasteful_version: TASTEFUL_VERSION,
      decisions,
      gates,
      ...(gateErrors.length > 0 ? { gate_errors: gateErrors } : {}),
      journal_seq: journalSeq,
      journal_ok: journalOk,
      ...(journalError !== undefined ? { journal_error: journalError } : {}),
    };
    if (json) return canonicalJson(status) + "\n";
    const gateSummary =
      gateErrors.length > 0
        ? `gates: ${gates.length} ok, ${gateErrors.length} errors`
        : `gates: ${gates.map((x) => `${x.gate_id}=${x.decision}`).join(", ") || "none"}`;
    const lines = [
      `project: ${g.project} (tasteful ${TASTEFUL_VERSION})`,
      `decisions: ${decisions.length}`,
      ...decisions.map((d) => `  ${d.id} ${d.status}/${d.review_state} v${d.version}`),
      gateSummary,
      ...gateErrors.map((e) => `  gate error: ${e.file}: ${e.error}`),
      `journal: seq=${journalSeq} ok=${journalOk}${journalError !== undefined ? ` error=${journalError}` : ""}`,
    ];
    return lines.join("\n") + "\n";
  } catch (err) {
    throw mapError(err);
  }
}

export async function cmdExportHash(g: GlobalOpts, file: string): Promise<string> {
  try {
    const tc = makeCtx(g.project);
    const abs = await resolveProjectPath(tc, file, { mustExist: true });
    return `${await hashFile(abs)}\n`;
  } catch (err) {
    throw mapError(err);
  }
}
