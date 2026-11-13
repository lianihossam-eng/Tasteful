/**
 * Decision / change-event / gate / coverage types + strict validators.
 * Mirrors docs/contracts/*.json. Unknown fields are rejected.
 */
import { computeAuthoredContentHash } from "./hashes.js";

export class SchemaError extends Error {
  readonly code = "E_SCHEMA";
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";
export type ReviewState = "current" | "stale" | "needs_review" | "invalidated" | "blocked";

export interface Claim {
  claim_id: string;
  subject: string;
  predicate: string;
  value: string;
  scope: string;
  valid_from?: string;
}

export interface Evidence {
  type: string;
  ref: string;
  sha256?: string;
  captured_at?: string;
}

export interface DecisionArtifact {
  path: string;
  sha256: string;
  validator_version: number;
  validated_at?: string;
  checks?: string[];
  ready?: boolean;
}

export interface Decision {
  schema_version: 1;
  id: string;
  version: number;
  title: string;
  question: string;
  status: DecisionStatus;
  /** Derived by closure/validation transitions; rejected on authored input. */
  review_state?: ReviewState;
  owner: string;
  created_at: string;
  updated_at: string;
  claims: Claim[];
  depends_on: string[];
  supersedes?: string | null;
  supersede_reason?: string;
  reject_reason?: string;
  reject_link?: string;
  evidence: Evidence[];
  alternatives: string[];
  artifacts: DecisionArtifact[];
  rollback?: { to_version?: number; steps?: string[] };
  gate_ref?: string | null;
  /** Derived by the store (canonical authored content); verified on read. */
  decision_hash?: string;
}

export interface ChangeEvent {
  event_id: string;
  claim_id: string;
  old_value: string;
  new_value: string;
  source: string;
  occurred_at: string;
  reason: string;
  author: string;
}

/** Canonical record guard for boundary parsing (single definition; reuse, never redefine). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
/** `revoked` is a human transition (`gate revoke`), never an authored decision. */
export type GateVerdict = "pass" | "fail" | "pending" | "revoked";
export type ChecklistVerdict = "pass" | "fail" | "waived";

export interface GateChecklistItem {
  criterion: string;
  evidence_ref: string;
  verifier_role: string;
  verdict: ChecklistVerdict;
  date: string;
}

export interface GateWaiver {
  criterion: string;
  owner: string;
  expiry: string;
  rationale: string;
}

export interface Gate {
  gate_id: string;
  stage: string;
  checklist: GateChecklistItem[];
  decision: GateVerdict;
  approver: string;
  owner: string;
  waivers: GateWaiver[];
  /**
   * System-derived: digest of the consumed `gate_accept` approval that
   * authorized a `pass`. Stamped by `gate create --approval`; never authored.
   */
  approval_digest?: string;
}

export interface CoverageScreen {
  screen: string;
  states: string[];
  breakpoints: string[];
  decision: "in" | "out";
  rationale: string;
}

export interface CoverageMatrix {
  brief_id: string;
  platforms: string[];
  screens: CoverageScreen[];
}

const ID_RE = /^D[0-9]{3,}$/;
const CLAIM_RE = /^C-[A-Z0-9][A-Z0-9-]*$/;
const EVENT_RE = /^E-[A-Za-z0-9][A-Za-z0-9-]*$/;
const GATE_RE = /^G-[A-Z0-9][A-Z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DATE_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;


function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new SchemaError(`${what}: unknown field '${k}'`);
  }
}

function reqStr(obj: Record<string, unknown>, key: string, what: string, max = 2000): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length < 1 || v.length > max) {
    throw new SchemaError(`${what}.${key}: expected non-empty string`);
  }
  return v;
}

/**
 * Owner/approver identity field. Values are stored verbatim (content hash
 * stability), so surrounding whitespace is rejected rather than silently
 * rewritten; blank-only strings are rejected too. Comparison uses
 * `canonicalIdentity`/`sameIdentity` in ./identity.ts, never raw equality.
 */
function reqIdentityStr(obj: Record<string, unknown>, key: string, what: string, max = 200): string {
  const v = reqStr(obj, key, what, max);
  if (v !== v.trim()) {
    throw new SchemaError(`${what}.${key}: identity must not be empty or have leading/trailing whitespace`);
  }
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, what: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new SchemaError(`${what}.${key}: expected string`);
  return v;
}

function reqArr(obj: Record<string, unknown>, key: string, what: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new SchemaError(`${what}.${key}: expected array`);
  return v;
}

function reqInt(obj: Record<string, unknown>, key: string, what: string, min: number): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new SchemaError(`${what}.${key}: expected integer >= ${min}`);
  }
  return v;
}

const DECISION_KEYS = [
  "schema_version", "id", "version", "title", "question", "status", "review_state",
  "owner", "created_at", "updated_at", "claims", "depends_on", "supersedes",
  "supersede_reason", "reject_reason", "reject_link", "evidence", "alternatives",
  "artifacts", "rollback", "gate_ref", "decision_hash",
] as const;

const CLAIM_KEYS = ["claim_id", "subject", "predicate", "value", "scope", "valid_from"] as const;
const EVIDENCE_KEYS = ["type", "ref", "sha256", "captured_at"] as const;
const ARTIFACT_KEYS = ["path", "sha256", "validator_version", "validated_at", "checks", "ready"] as const;

const STATUSES: DecisionStatus[] = ["proposed", "accepted", "superseded", "rejected"];
const REVIEW_STATES: ReviewState[] = ["current", "stale", "needs_review", "invalidated", "blocked"];

export function validateClaim(v: unknown, what: string): Claim {
  if (!isRecord(v)) throw new SchemaError(`${what}: expected object`);
  checkKeys(v, CLAIM_KEYS, what);
  const claim_id = reqStr(v, "claim_id", what, 120);
  if (!CLAIM_RE.test(claim_id)) throw new SchemaError(`${what}.claim_id: bad format`);
  return {
    claim_id,
    subject: reqStr(v, "subject", what, 200),
    predicate: reqStr(v, "predicate", what, 120),
    value: reqStr(v, "value", what, 500),
    scope: reqStr(v, "scope", what, 120),
    ...(v.valid_from !== undefined ? { valid_from: optStr(v, "valid_from", what) } : {}),
  };
}

function validateEvidence(v: unknown, what: string): Evidence {
  if (!isRecord(v)) throw new SchemaError(`${what}: expected object`);
  checkKeys(v, EVIDENCE_KEYS, what);
  const sha = optStr(v, "sha256", what);
  if (sha !== undefined && !SHA_RE.test(sha)) throw new SchemaError(`${what}.sha256: bad format`);
  return {
    type: reqStr(v, "type", what, 120),
    ref: reqStr(v, "ref", what, 500),
    ...(sha !== undefined ? { sha256: sha } : {}),
    ...(v.captured_at !== undefined ? { captured_at: optStr(v, "captured_at", what) } : {}),
  };
}

function validateArtifact(v: unknown, what: string): DecisionArtifact {
  if (!isRecord(v)) throw new SchemaError(`${what}: expected object`);
  checkKeys(v, ARTIFACT_KEYS, what);
  const sha = reqStr(v, "sha256", what, 64);
  if (!SHA_RE.test(sha)) throw new SchemaError(`${what}.sha256: bad format`);
  let checks: string[] | undefined;
  if (v.checks !== undefined) {
    if (!Array.isArray(v.checks) || !v.checks.every((c) => typeof c === "string")) {
      throw new SchemaError(`${what}.checks: expected string array`);
    }
    checks = [...(v.checks as string[])];
  }
  let ready: boolean | undefined;
  if (v.ready !== undefined) {
    if (typeof v.ready !== "boolean") throw new SchemaError(`${what}.ready: expected boolean`);
    ready = v.ready;
  }
  return {
    path: reqStr(v, "path", what, 500),
    sha256: sha,
    validator_version: reqInt(v, "validator_version", what, 1),
    ...(v.validated_at !== undefined ? { validated_at: optStr(v, "validated_at", what) } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(ready !== undefined ? { ready } : {}),
  };
}

/**
 * Validate an authored decision (decision_upsert input). `review_state` and
 * `decision_hash` are derived: authored values are rejected rather than
 * silently ignored so a model cannot reset or forge invalidation.
 */
export function validateDecision(v: unknown): Decision {
  if (!isRecord(v)) throw new SchemaError("decision: expected object");
  if (Object.hasOwn(v, "review_state")) {
    throw new SchemaError("decision.review_state: derived field; remove it from authored input");
  }
  if (Object.hasOwn(v, "decision_hash")) {
    throw new SchemaError("decision.decision_hash: derived field; remove it from authored input");
  }
  return validateDecisionRecord(v, false);
}

/** Validate a stored decision record (derived fields present, hash verified by the store). */
export function validateStoredDecision(v: unknown): Decision {
  return validateDecisionRecord(v, true);
}

function validateDecisionRecord(v: unknown, allowDerived: boolean): Decision {
  if (!isRecord(v)) throw new SchemaError("decision: expected object");
  checkKeys(v, DECISION_KEYS, "decision");
  if (v.schema_version !== 1) throw new SchemaError("decision.schema_version: must be 1");
  const id = reqStr(v, "id", "decision", 32);
  if (!ID_RE.test(id)) throw new SchemaError("decision.id: bad format");
  const status = reqStr(v, "status", "decision", 32);
  if (!STATUSES.includes(status as DecisionStatus)) throw new SchemaError("decision.status: invalid");
  let review_state: ReviewState | undefined;
  if (v.review_state !== undefined) {
    if (!allowDerived) throw new SchemaError("decision.review_state: derived field; remove it from authored input");
    const rs = reqStr(v, "review_state", "decision", 32);
    if (!REVIEW_STATES.includes(rs as ReviewState)) throw new SchemaError("decision.review_state: invalid");
    review_state = rs as ReviewState;
  }
  const created_at = reqStr(v, "created_at", "decision", 64);
  const updated_at = reqStr(v, "updated_at", "decision", 64);
  if (!DATE_PREFIX.test(created_at) || !DATE_PREFIX.test(updated_at)) {
    throw new SchemaError("decision.created_at/updated_at: expected ISO date");
  }
  const claims = reqArr(v, "claims", "decision").map((c, i) => validateClaim(c, `decision.claims[${i}]`));
  const dependsRaw = reqArr(v, "depends_on", "decision");
  const depends_on: string[] = [];
  const seen = new Set<string>();
  for (const d of dependsRaw) {
    if (typeof d !== "string" || !ID_RE.test(d)) throw new SchemaError("decision.depends_on: bad id");
    if (d === id) throw new SchemaError("decision.depends_on: self-edge rejected");
    if (seen.has(d)) throw new SchemaError("decision.depends_on: duplicate");
    seen.add(d);
    depends_on.push(d);
  }
  const evidence = reqArr(v, "evidence", "decision").map((e, i) => validateEvidence(e, `decision.evidence[${i}]`));
  const altRaw = reqArr(v, "alternatives", "decision");
  if (!altRaw.every((a) => typeof a === "string")) throw new SchemaError("decision.alternatives: strings only");
  const artifacts = reqArr(v, "artifacts", "decision").map((a, i) =>
    validateArtifact(a, `decision.artifacts[${i}]`),
  );
  if ((status === "superseded" || status === "rejected") && v.supersedes == null && v.reject_reason == null && v.supersede_reason == null) {
    throw new SchemaError(`decision: status '${status}' requires a reason/link`);
  }
  let supersedes: string | null | undefined;
  if (v.supersedes !== undefined && v.supersedes !== null) {
    if (typeof v.supersedes !== "string" || !ID_RE.test(v.supersedes)) {
      throw new SchemaError("decision.supersedes: bad id");
    }
    supersedes = v.supersedes;
  } else if (v.supersedes === null) {
    supersedes = null;
  }
  let rollback: Decision["rollback"];
  if (v.rollback !== undefined) {
    if (!isRecord(v.rollback)) throw new SchemaError("decision.rollback: expected object");
    checkKeys(v.rollback, ["to_version", "steps"], "decision.rollback");
    const steps = v.rollback.steps;
    if (steps !== undefined && (!Array.isArray(steps) || !steps.every((s) => typeof s === "string"))) {
      throw new SchemaError("decision.rollback.steps: strings only");
    }
    const to_version = v.rollback.to_version;
    if (to_version !== undefined && (typeof to_version !== "number" || !Number.isInteger(to_version))) {
      throw new SchemaError("decision.rollback.to_version: expected integer");
    }
    rollback = {
      ...(to_version !== undefined ? { to_version: to_version as number } : {}),
      ...(steps !== undefined ? { steps: [...(steps as string[])] } : {}),
    };
  }
  let gate_ref: string | null | undefined;
  if (v.gate_ref !== undefined && v.gate_ref !== null) {
    if (typeof v.gate_ref !== "string" || !GATE_RE.test(v.gate_ref)) {
      throw new SchemaError("decision.gate_ref: bad format");
    }
    gate_ref = v.gate_ref;
  } else if (v.gate_ref === null) {
    gate_ref = null;
  }
  if (!allowDerived && v.decision_hash !== undefined) {
    throw new SchemaError("decision.decision_hash: derived field; remove it from authored input");
  }
  const hash = optStr(v, "decision_hash", "decision");
  if (hash !== undefined && !SHA_RE.test(hash)) throw new SchemaError("decision.decision_hash: bad format");
  return {
    schema_version: 1,
    id,
    version: reqInt(v, "version", "decision", 1),
    title: reqStr(v, "title", "decision", 200),
    question: reqStr(v, "question", "decision", 500),
    status: status as DecisionStatus,
    ...(review_state !== undefined ? { review_state } : {}),
    owner: reqIdentityStr(v, "owner", "decision", 200),
    created_at,
    updated_at,
    claims,
    depends_on,
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(v.supersede_reason !== undefined ? { supersede_reason: optStr(v, "supersede_reason", "decision") } : {}),
    ...(v.reject_reason !== undefined ? { reject_reason: optStr(v, "reject_reason", "decision") } : {}),
    ...(v.reject_link !== undefined ? { reject_link: optStr(v, "reject_link", "decision") } : {}),
    evidence,
    alternatives: [...(altRaw as string[])],
    artifacts,
    ...(rollback !== undefined ? { rollback } : {}),
    ...(gate_ref !== undefined ? { gate_ref } : {}),
    ...(hash !== undefined ? { decision_hash: hash } : {}),
  };
}

const EVENT_KEYS = [
  "event_id", "claim_id", "old_value", "new_value", "source", "occurred_at", "reason", "author",
] as const;

export function validateChangeEvent(v: unknown): ChangeEvent {
  if (!isRecord(v)) throw new SchemaError("event: expected object");
  checkKeys(v, EVENT_KEYS, "event");
  const event_id = reqStr(v, "event_id", "event", 120);
  if (!EVENT_RE.test(event_id)) throw new SchemaError("event.event_id: bad format");
  const claim_id = reqStr(v, "claim_id", "event", 120);
  if (!CLAIM_RE.test(claim_id)) throw new SchemaError("event.claim_id: bad format");
  return {
    event_id,
    claim_id,
    old_value: reqStr(v, "old_value", "event", 500),
    new_value: reqStr(v, "new_value", "event", 500),
    source: reqStr(v, "source", "event", 120),
    occurred_at: reqStr(v, "occurred_at", "event", 64),
    reason: reqStr(v, "reason", "event", 2000),
    author: reqStr(v, "author", "event", 200),
  };
}

const GATE_KEYS = ["gate_id", "stage", "checklist", "decision", "approver", "owner", "waivers", "approval_digest"] as const;
const CHECK_KEYS = ["criterion", "evidence_ref", "verifier_role", "verdict", "date"] as const;
const WAIVER_KEYS = ["criterion", "owner", "expiry", "rationale"] as const;

export function validateGate(v: unknown): Gate {
  if (!isRecord(v)) throw new SchemaError("gate: expected object");
  checkKeys(v, GATE_KEYS, "gate");
  const gate_id = reqStr(v, "gate_id", "gate", 120);
  if (!GATE_RE.test(gate_id)) throw new SchemaError("gate.gate_id: bad format");
  const checklistRaw = reqArr(v, "checklist", "gate");
  if (checklistRaw.length < 1) throw new SchemaError("gate.checklist: min 1 item");
  const checklist: GateChecklistItem[] = checklistRaw.map((c, i) => {
    const what = `gate.checklist[${i}]`;
    if (!isRecord(c)) throw new SchemaError(`${what}: expected object`);
    checkKeys(c, CHECK_KEYS, what);
    const verdict = reqStr(c, "verdict", what, 16);
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "waived") {
      throw new SchemaError(`${what}.verdict: invalid`);
    }
    return {
      criterion: reqStr(c, "criterion", what),
      evidence_ref: reqStr(c, "evidence_ref", what),
      verifier_role: reqStr(c, "verifier_role", what, 120),
      verdict: verdict as ChecklistVerdict,
      date: reqStr(c, "date", what, 64),
    };
  });
  const decision = reqStr(v, "decision", "gate", 16);
  if (decision !== "pass" && decision !== "fail" && decision !== "pending" && decision !== "revoked") {
    throw new SchemaError("gate.decision: invalid");
  }
  const approval_digest = optStr(v, "approval_digest", "gate");
  if (approval_digest !== undefined && !SHA_RE.test(approval_digest)) {
    throw new SchemaError("gate.approval_digest: must be 64 lowercase hex");
  }
  const waivers = reqArr(v, "waivers", "gate").map((w, i) => {
    const what = `gate.waivers[${i}]`;
    if (!isRecord(w)) throw new SchemaError(`${what}: expected object`);
    checkKeys(w, WAIVER_KEYS, what);
    return {
      criterion: reqStr(w, "criterion", what),
      owner: reqIdentityStr(w, "owner", what, 200),
      expiry: reqStr(w, "expiry", what, 64),
      rationale: reqStr(w, "rationale", what),
    };
  });
  return {
    gate_id,
    stage: reqStr(v, "stage", "gate", 120),
    checklist,
    decision: decision as GateVerdict,
    approver: reqIdentityStr(v, "approver", "gate", 200),
    owner: reqIdentityStr(v, "owner", "gate", 200),
    waivers,
    ...(approval_digest !== undefined ? { approval_digest } : {}),
  };
}

const COVERAGE_KEYS = ["brief_id", "platforms", "screens"] as const;
const SCREEN_KEYS = ["screen", "states", "breakpoints", "decision", "rationale"] as const;

export function validateCoverage(v: unknown): CoverageMatrix {
  if (!isRecord(v)) throw new SchemaError("coverage: expected object");
  checkKeys(v, COVERAGE_KEYS, "coverage");
  const platforms = reqArr(v, "platforms", "coverage");
  if (platforms.length < 1 || !platforms.every((p) => typeof p === "string" && p.length > 0)) {
    throw new SchemaError("coverage.platforms: min 1 non-empty string");
  }
  const screensRaw = reqArr(v, "screens", "coverage");
  if (screensRaw.length < 1) throw new SchemaError("coverage.screens: min 1");
  const screens: CoverageScreen[] = screensRaw.map((s, i) => {
    const what = `coverage.screens[${i}]`;
    if (!isRecord(s)) throw new SchemaError(`${what}: expected object`);
    checkKeys(s, SCREEN_KEYS, what);
    const states = reqArr(s, "states", what);
    const bps = reqArr(s, "breakpoints", what);
    if (states.length < 1 || !states.every((x) => typeof x === "string" && x.length > 0)) {
      throw new SchemaError(`${what}.states: min 1`);
    }
    if (bps.length < 1 || !bps.every((x) => typeof x === "string" && x.length > 0)) {
      throw new SchemaError(`${what}.breakpoints: min 1`);
    }
    const decision = reqStr(s, "decision", what, 8);
    if (decision !== "in" && decision !== "out") throw new SchemaError(`${what}.decision: in|out`);
    return {
      screen: reqStr(s, "screen", what, 200),
      states: [...(states as string[])],
      breakpoints: [...(bps as string[])],
      decision: decision as "in" | "out",
      rationale: reqStr(s, "rationale", what),
    };
  });
  return {
    brief_id: reqStr(v, "brief_id", "coverage", 120),
    platforms: [...(platforms as string[])],
    screens,
  };
}

/**
 * decision_hash covers authored content only: excludes review_state (derived)
 * and decision_hash itself. Stable under key reorder (canonical JSON).
 * Same function that binds human acceptance approvals.
 */
export function computeDecisionHash(d: Decision): string {
  return computeAuthoredContentHash(d);
}
