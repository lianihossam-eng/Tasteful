import { throwsWithCode } from "../assert-code.js";
/** Golden closure: D001-D007 scope-change scenario (plan §5.5/H11). */
import assert from "node:assert/strict";
import test from "node:test";
import { applyClosure, computeClosure } from "../../src/design/invalidate.js";
import { validateChangeEvent, type Decision } from "../../src/design/schema.js";
import { GOLDEN_STATES, scenarioEvent, scenarioGraph } from "../fixtures/decisions.js";

function statesAfter(all: Map<string, Decision>): Record<string, string> {
  const states: Record<string, string> = {};
  for (const [id, d] of all) states[id] = d.review_state ?? "current";
  return states;
}

test("scope change C-PLATFORM-MOBILE yields the exact plan closure for all 7 decisions", () => {
  const all = scenarioGraph();
  const event = validateChangeEvent(scenarioEvent());

  // D001 and D002 both reference the claim directly: BOTH are stale.
  // D006 is accepted with gate_ref: invalidated. Dependents: needs_review.
  // D004/D007 are outside the closure and stay current.
  const closure = computeClosure(all, event);
  assert.deepEqual(closure.changed, {
    D001: "stale",
    D002: "stale",
    D003: "needs_review",
    D005: "needs_review",
    D006: "invalidated",
  });
  assert.deepEqual(closure.artifactsCleared, ["D001", "D002", "D003", "D005", "D006"]);

  const applied = applyClosure(all, closure, "2026-11-12");
  assert.deepEqual(statesAfter(applied), GOLDEN_STATES);

  // No artifact of any in-closure decision remains ready.
  for (const id of Object.keys(closure.changed)) {
    for (const artifact of applied.get(id)!.artifacts) {
      assert.equal(artifact.ready, false, `${id} artifact ${artifact.path} must not be ready`);
    }
  }
  // Untouched branch stays ready.
  for (const id of ["D004", "D007"]) {
    for (const artifact of applied.get(id)!.artifacts) {
      assert.equal(artifact.ready, true, `${id} is outside the closure and stays ready`);
    }
  }
  // The closure itself is pure: the input map is unchanged.
  assert.equal(all.get("D001")!.review_state, undefined);
  assert.equal(all.get("D001")!.artifacts[0].ready, true);
});

test("prose-only change (unknown claim) is rejected, not silently applied", () => {
  const all = scenarioGraph();
  const event = validateChangeEvent(scenarioEvent({
    event_id: "E-2026-11-11-002",
    claim_id: "C-NOT-A-CLAIM",
    reason: "prose",
  }));
  throwsWithCode(() => computeClosure(all, event), "E_CLAIM_UNKNOWN");
});

test("graph without the claim reference on untouched branch stays current", () => {
  const all = scenarioGraph();
  const event = validateChangeEvent(scenarioEvent({ event_id: "E-2026-11-11-003" }));
  const closure = computeClosure(all, event);
  assert.ok(!("D004" in closure.changed));
  assert.ok(!("D007" in closure.changed));
});
