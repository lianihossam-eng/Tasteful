/**
 * Approval store: digest-bound, single-use records under .tasteful/approvals/.
 * Deny by default in headless/test. Replay and mutated payloads rejected.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "../design/hashes.js";
import { isRecord } from "../design/schema.js";
import { writeFileAtomic, type ProjectPaths } from "../design/store.js";

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export interface ApprovalRecord {
  digest: string;
  tool: string;
  target: string;
  content_hash: string;
  params_hash: string;
  approver: string;
  created_at: string;
  used: boolean;
  used_at?: string;
  decision?: "granted" | "denied";
}

/** Digest binds tool + target + content + argv/params + tool version. */
export function operationDigest(input: {
  tool: string;
  target: string;
  content: string;
  params: unknown;
  toolVersion?: number;
}): string {
  return sha256Hex(
    canonicalJson({
      tool: input.tool,
      target: input.target,
      content: input.content,
      params: input.params ?? null,
      toolVersion: input.toolVersion ?? 1,
    }),
  );
}

function recordFile(p: ProjectPaths, digest: string): string {
  return path.join(p.approvals, `${digest.slice(0, 32)}.json`);
}

/**
 * Resolve a caller-supplied approval id to a record inside the approvals
 * directory. Only a 64-hex digest or a bare `*.json` basename is accepted;
 * absolute paths, separators, and dot segments are rejected.
 */
export function resolveApprovalRecordPath(p: ProjectPaths, approvalId: string): string {
  if (typeof approvalId !== "string" || approvalId.length === 0 || approvalId.length > 128) {
    throw new ApprovalError("E_APPROVAL_PATH", "approval id must be a digest or basename");
  }
  if (approvalId.includes("\0")) throw new ApprovalError("E_APPROVAL_PATH", "approval id contains NUL");
  if (path.isAbsolute(approvalId) || approvalId.includes("/") || approvalId.includes("\\")) {
    throw new ApprovalError("E_APPROVAL_PATH", "approval id must be a basename, not a path");
  }
  if (approvalId === "." || approvalId === ".." || approvalId !== path.basename(approvalId)) {
    throw new ApprovalError("E_APPROVAL_PATH", "approval id must be a basename, not a path");
  }
  let file: string;
  if (/^[a-f0-9]{64}$/.test(approvalId)) {
    file = path.join(p.approvals, `${approvalId.slice(0, 32)}.json`);
  } else if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(approvalId)) {
    file = path.join(p.approvals, approvalId);
  } else {
    throw new ApprovalError("E_APPROVAL_PATH", "approval id must be a 64-hex digest or a *.json basename");
  }
  if (path.dirname(path.resolve(file)) !== path.resolve(p.approvals)) {
    throw new ApprovalError("E_APPROVAL_PATH", "approval id escapes the approvals directory");
  }
  return file;
}

export function contentHash(content: string): string {
  return sha256Hex(content);
}

export function paramsHash(params: unknown): string {
  return sha256Hex(canonicalJson(params ?? null));
}

/** Interactive grant: creates a single-use approval record. */
export async function grantApproval(
  p: ProjectPaths,
  input: { tool: string; target: string; content: string; params: unknown; approver: string },
): Promise<ApprovalRecord> {
  const digest = operationDigest(input);
  const record: ApprovalRecord = {
    digest,
    tool: input.tool,
    target: input.target,
    content_hash: contentHash(input.content),
    params_hash: paramsHash(input.params),
    approver: input.approver,
    created_at: new Date().toISOString(),
    used: false,
    decision: "granted",
  };
  await writeFileAtomic(recordFile(p, digest), canonicalJson(record) + "\n");
  return record;
}

export async function denyApproval(
  p: ProjectPaths,
  input: { tool: string; target: string; content: string; params: unknown; approver: string },
): Promise<ApprovalRecord> {
  const digest = operationDigest(input);
  const record: ApprovalRecord = {
    digest,
    tool: input.tool,
    target: input.target,
    content_hash: contentHash(input.content),
    params_hash: paramsHash(input.params),
    approver: input.approver,
    created_at: new Date().toISOString(),
    used: false,
    decision: "denied",
  };
  await writeFileAtomic(recordFile(p, digest), canonicalJson(record) + "\n");
  return record;
}

/**
 * Consume a grant for the exact operation. Throws E_APPROVAL_* on deny,
 * replay, or mutation. Marks the record used atomically (best effort under
 * the project lock held by the caller).
 *
 * `approvalId` (digest or basename) selects the record explicitly; without it
 * the record is located by the operation digest. Either way the stored digest,
 * target, content_hash, and params_hash must match the requested operation.
 */
export async function consumeApproval(
  p: ProjectPaths,
  input: { tool: string; target: string; content: string; params: unknown; approvalId?: string },
): Promise<ApprovalRecord> {
  const expectedDigest = operationDigest(input);
  const file = input.approvalId !== undefined ? resolveApprovalRecordPath(p, input.approvalId) : recordFile(p, expectedDigest);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new ApprovalError("E_APPROVAL_DENIED", `no approval for ${input.tool} ${input.target}`);
  }
  if (!isRecord(raw)) throw new ApprovalError("E_APPROVAL_DENIED", "approval record corrupt");
  const rec = raw as unknown as ApprovalRecord;
  if (rec.decision === "denied") throw new ApprovalError("E_APPROVAL_DENIED", "operation was denied");
  if (rec.decision !== "granted") throw new ApprovalError("E_APPROVAL_DENIED", "operation not granted");
  if (rec.used) throw new ApprovalError("E_APPROVAL_REPLAY", "approval already used");
  if (rec.tool !== input.tool || rec.target !== input.target) {
    throw new ApprovalError("E_APPROVAL_MUTATED", "approval target mismatch");
  }
  if (rec.digest !== expectedDigest) {
    throw new ApprovalError("E_APPROVAL_MUTATED", "approval digest mismatch");
  }
  if (rec.content_hash !== contentHash(input.content) || rec.params_hash !== paramsHash(input.params)) {
    throw new ApprovalError("E_APPROVAL_MUTATED", "approval payload mutated");
  }
  // A basename id must correspond to the digest it claims.
  const base = path.basename(file);
  if (/^[a-f0-9]{32}\.json$/.test(base) && base !== `${expectedDigest.slice(0, 32)}.json`) {
    throw new ApprovalError("E_APPROVAL_MUTATED", "approval id does not match its digest");
  }
  const used: ApprovalRecord = { ...rec, used: true, used_at: new Date().toISOString() };
  await writeFileAtomic(file, canonicalJson(used) + "\n");
  return used;
}

/**
 * Content-bound grant: the record stores `contentHash` directly as its
 * `content_hash` (it is already a sha256 of canonical authored content), and
 * the digest binds that exact value. Used for `decision_accept`/`gate_accept`
 * where the approved object is a canonical-hash, not a raw payload string.
 */
export async function grantContentBoundApproval(
  p: ProjectPaths,
  input: { tool: string; target: string; contentHash: string; params: unknown; approver: string },
): Promise<ApprovalRecord> {
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "content hash must be 64 lowercase hex");
  }
  const digest = operationDigest({
    tool: input.tool,
    target: input.target,
    content: input.contentHash,
    params: input.params,
  });
  const record: ApprovalRecord = {
    digest,
    tool: input.tool,
    target: input.target,
    content_hash: input.contentHash,
    params_hash: paramsHash(input.params),
    approver: input.approver,
    created_at: new Date().toISOString(),
    used: false,
    decision: "granted",
  };
  await writeFileAtomic(recordFile(p, digest), canonicalJson(record) + "\n");
  return record;
}

/** Read a record by caller-supplied id (basename or digest) under the approvals dir. */
export async function readApprovalRecord(
  p: ProjectPaths,
  approvalId: string,
): Promise<{ file: string; record: ApprovalRecord }> {
  const file = resolveApprovalRecordPath(p, approvalId);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new ApprovalError("E_APPROVAL_DENIED", `no approval record: ${approvalId}`);
  }
  if (!isRecord(raw)) throw new ApprovalError("E_APPROVAL_DENIED", "approval record corrupt");
  const record = raw as unknown as ApprovalRecord;
  if (typeof record.approver !== "string" || record.approver.length === 0) {
    throw new ApprovalError("E_APPROVAL_MUTATED", "approval record lacks approver");
  }
  return { file, record };
}

/**
 * Consume a content-bound grant for the exact operation. Unlike
 * `consumeApproval`, `contentHash` is the already-computed sha256 of the
 * approved object (canonical authored decision/gate content) and is compared
 * to the record's `content_hash` directly. Digest/target/params/hash mismatch
 * is `E_APPROVAL_MISMATCH`; missing/denied/replay keep their own codes.
 */
export async function consumeContentBoundApproval(
  p: ProjectPaths,
  input: { tool: string; target: string; contentHash: string; params: unknown; approvalId: string },
): Promise<ApprovalRecord> {
  const expectedDigest = operationDigest({
    tool: input.tool,
    target: input.target,
    content: input.contentHash,
    params: input.params,
  });
  const file = resolveApprovalRecordPath(p, input.approvalId);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new ApprovalError("E_APPROVAL_DENIED", `no approval for ${input.tool} ${input.target}`);
  }
  if (!isRecord(raw)) throw new ApprovalError("E_APPROVAL_DENIED", "approval record corrupt");
  const rec = raw as unknown as ApprovalRecord;
  if (rec.decision === "denied") throw new ApprovalError("E_APPROVAL_DENIED", "operation was denied");
  if (rec.decision !== "granted") throw new ApprovalError("E_APPROVAL_DENIED", "operation not granted");
  if (rec.used) throw new ApprovalError("E_APPROVAL_REPLAY", "approval already used");
  if (rec.tool !== input.tool || rec.target !== input.target) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "approval target mismatch");
  }
  if (rec.digest !== expectedDigest) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "approval digest mismatch");
  }
  if (rec.content_hash !== input.contentHash) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "approved content changed");
  }
  if (rec.params_hash !== paramsHash(input.params)) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "approval payload mutated");
  }
  const base = path.basename(file);
  if (/^[a-f0-9]{32}\.json$/.test(base) && base !== `${expectedDigest.slice(0, 32)}.json`) {
    throw new ApprovalError("E_APPROVAL_MISMATCH", "approval id does not match its digest");
  }
  const used: ApprovalRecord = { ...rec, used: true, used_at: new Date().toISOString() };
  await writeFileAtomic(file, canonicalJson(used) + "\n");
  return used;
}

/** List pending (granted, unused) approvals for interactive review. */
export async function listPendingApprovals(p: ProjectPaths): Promise<ApprovalRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.approvals);
  } catch {
    return [];
  }
  const out: ApprovalRecord[] = [];
  for (const e of entries.sort()) {
    if (!e.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(p.approvals, e), "utf8")) as unknown;
      if (!isRecord(raw)) continue;
      const rec = raw as unknown as ApprovalRecord;
      if (rec.decision === "granted" && !rec.used) out.push(rec);
    } catch {
      // ignore unreadable records
    }
  }
  return out;
}
