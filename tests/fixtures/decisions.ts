/**
 * Shared D001-D007 closure scenario (design §Invalidation closure golden).
 * Pure in-memory map: every decision carries one artifact so tests can assert
 * that all in-closure artifacts end with `ready: false`.
 */
import type { ChangeEvent, Decision, DecisionArtifact } from "../../src/design/schema.js";
import { decisionBase } from "../helpers.js";

export const SCENARIO_CLAIM = "C-PLATFORM-MOBILE";

const MOBILE_CLAIM = {
  claim_id: SCENARIO_CLAIM,
  subject: "platform.mobile",
  predicate: "is",
  value: "mobile-web",
  scope: "project",
};

function artifactFor(id: string): DecisionArtifact {
  return {
    path: `artifacts/${id}.bin`,
    sha256: "a".repeat(64),
    validator_version: 1,
    validated_at: "2026-11-11",
    checks: ["opens", "exports"],
    ready: true,
  };
}

/**
 * D001 proposed non-gate defines C-PLATFORM-MOBILE.
 * D002 proposed non-gate references it and depends_on D001.
 * D003/D005 proposed depend on D002. D004 standalone. D007 depends on D004.
 * D006 is the validation decision: accepted + gate_ref, depends on D003+D005.
 */
export function scenarioGraph(): Map<string, Decision> {
  const all = new Map<string, Decision>();
  all.set("D001", decisionBase("D001", {
    title: "Platform scope",
    status: "proposed",
    claims: [MOBILE_CLAIM],
    artifacts: [artifactFor("D001")],
  }));
  all.set("D002", decisionBase("D002", {
    title: "Mobile navigation",
    status: "proposed",
    claims: [MOBILE_CLAIM],
    depends_on: ["D001"],
    artifacts: [artifactFor("D002")],
  }));
  all.set("D003", decisionBase("D003", {
    title: "Checkout flow",
    status: "proposed",
    depends_on: ["D002"],
    artifacts: [artifactFor("D003")],
  }));
  all.set("D004", decisionBase("D004", {
    title: "About page",
    status: "proposed",
    artifacts: [artifactFor("D004")],
  }));
  all.set("D005", decisionBase("D005", {
    title: "Design tokens",
    status: "proposed",
    depends_on: ["D002"],
    artifacts: [artifactFor("D005")],
  }));
  all.set("D006", decisionBase("D006", {
    title: "Design review acceptance",
    status: "accepted",
    gate_ref: "G-DESIGN-REVIEW",
    depends_on: ["D003", "D005"],
    evidence: [{ type: "review", ref: "reviews/design.md", sha256: "b".repeat(64) }],
    artifacts: [artifactFor("D006")],
  }));
  all.set("D007", decisionBase("D007", {
    title: "Handoff checklist",
    status: "proposed",
    depends_on: ["D004"],
    artifacts: [artifactFor("D007")],
  }));
  return all;
}

export function scenarioEvent(overrides?: Partial<ChangeEvent>): ChangeEvent {
  return {
    event_id: "E-2026-11-11-001",
    claim_id: SCENARIO_CLAIM,
    old_value: "mobile-web",
    new_value: "mobile-web+ios",
    source: "scope-change",
    occurred_at: "2026-11-11",
    reason: "sponsor adds a native iOS app",
    author: "designer@example",
    ...overrides,
  };
}

/** Expected golden states for the scenario closure. */
export const GOLDEN_STATES: Record<string, string> = {
  D001: "stale",
  D002: "stale",
  D003: "needs_review",
  D004: "current",
  D005: "needs_review",
  D006: "invalidated",
  D007: "current",
};
