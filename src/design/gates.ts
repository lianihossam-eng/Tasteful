/** Gate validation: approver!=owner, evidence, waivers. Pure. */
import { assertNotSelf } from "./identity.js";
import type { Gate } from "./schema.js";

export class GateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}

/**
 * Throws E_SELF_APPROVAL / E_GATE_BLOCKED / E_SCHEMA on violation.
 * A `pass` gate requires every checklist item pass|waived-with-waiver.
 */
export function assertGatePassable(g: Gate): void {
  if (g.decision === "revoked") {
    throw new GateError("E_GATE_BLOCKED", `gate ${g.gate_id}: decision is 'revoked'`);
  }
  assertNotSelf(g.approver, g.owner, `gate ${g.gate_id}: approver == owner`);
  if (g.decision !== "pass") {
    throw new GateError("E_GATE_BLOCKED", `gate ${g.gate_id}: decision is '${g.decision}'`);
  }
  const waived = new Set(g.waivers.map((w) => w.criterion));
  for (const item of g.checklist) {
    if (!item.evidence_ref) {
      throw new GateError("E_GATE_BLOCKED", `gate ${g.gate_id}: '${item.criterion}' lacks evidence`);
    }
    if (item.verdict === "fail") {
      throw new GateError("E_GATE_BLOCKED", `gate ${g.gate_id}: '${item.criterion}' failed`);
    }
    if (item.verdict === "waived" && !waived.has(item.criterion)) {
      throw new GateError("E_GATE_BLOCKED", `gate ${g.gate_id}: '${item.criterion}' waived without waiver`);
    }
  }
}

/** Non-throwing check used by decision acceptance. */
export function gatePasses(g: Gate): boolean {
  try {
    assertGatePassable(g);
    return true;
  } catch {
    return false;
  }
}
