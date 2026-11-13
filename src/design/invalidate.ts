/**
 * Change-event closure: deterministic invalidation over depends_on.
 * Pure w.r.t. inputs; persistence is the caller's job (store + journal).
 *
 * Normative rule (design §Invalidation closure, plan §5.5/H11):
 * 1. Direct claim hits are `stale`, EXCEPT validation decisions
 *    (status accepted AND gate_ref != null) which are `invalidated`.
 * 2. Every transitive reverse-`depends_on` dependent is `needs_review`,
 *    EXCEPT validation decisions which are `invalidated`.
 * 3. Decisions outside the closure stay `current`.
 * 4. Every artifact of every in-closure decision gets `ready: false`.
 * There is no direct-hit-to-direct-hit exception: two decisions referencing
 * the same claim are both stale unless they are validation decisions.
 */
import type { ChangeEvent, Decision, ReviewState } from "./schema.js";
import { StoreError } from "./store.js";

export interface ClosureResult {
  event: ChangeEvent;
  /** id -> new review_state for every decision whose state changed */
  changed: Record<string, ReviewState>;
  /** decision ids whose artifacts are cleared (all in-closure ids with artifacts) */
  artifactsCleared: string[];
}

function isValidationDecision(d: Decision): boolean {
  return d.status === "accepted" && d.gate_ref != null;
}

/** Reverse adjacency: dependency id -> decisions that depend on it. */
function reverseAdjacency(all: Map<string, Decision>): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();
  for (const [id, d] of all) {
    for (const dep of d.depends_on) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(id);
    }
  }
  return dependents;
}

/**
 * Compute the closure. Never changes `status`; review_state only. Callers
 * persist via store system writes, never via authored `decision_upsert`.
 */
export function computeClosure(
  all: Map<string, Decision>,
  event: ChangeEvent,
): ClosureResult {
  const direct = new Set<string>();
  for (const [id, d] of all) {
    if (d.claims.some((c) => c.claim_id === event.claim_id)) direct.add(id);
  }
  if (direct.size === 0) {
    throw new StoreError("E_CLAIM_UNKNOWN", `no decision references ${event.claim_id}`);
  }

  const dependents = reverseAdjacency(all);
  const changed = new Map<string, ReviewState>();

  // Rule 1: direct hits.
  for (const id of direct) {
    const d = all.get(id)!;
    changed.set(id, isValidationDecision(d) ? "invalidated" : "stale");
  }

  // Rule 2: transitive dependents.
  const queue = [...direct];
  const inClosure = new Set<string>(direct);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dep of dependents.get(cur) ?? []) {
      if (inClosure.has(dep)) continue;
      inClosure.add(dep);
      queue.push(dep);
      const d = all.get(dep);
      if (!d) continue; // dangling dep is rejected on write; ignore defensively
      changed.set(dep, isValidationDecision(d) ? "invalidated" : "needs_review");
    }
  }

  // Rule 3: all artifacts of all in-closure decisions are cleared.
  const artifactsCleared = [...inClosure].filter((id) => (all.get(id)?.artifacts.length ?? 0) > 0);

  return {
    event,
    changed: Object.fromEntries([...changed.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    artifactsCleared: artifactsCleared.sort(),
  };
}

/**
 * Apply a closure to an in-memory decision map: sets review_state and clears
 * every artifact `ready` flag on in-closure decisions. Callers persist the
 * returned records through the store's system writer.
 */
export function applyClosure(
  all: Map<string, Decision>,
  closure: ClosureResult,
  updatedAt?: string,
): Map<string, Decision> {
  const out = new Map(all);
  for (const [id, state] of Object.entries(closure.changed)) {
    const d = out.get(id);
    if (!d) continue;
    out.set(id, {
      ...d,
      review_state: state,
      ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
      artifacts: d.artifacts.map((a) => ({ ...a, ready: false })),
    });
  }
  return out;
}

/**
 * The affected set for a local mutation (artifact drift): the roots plus
 * every transitive reverse-`depends_on` dependent. Sorted for determinism.
 */
export function collectReverseDependents(
  all: Map<string, Decision>,
  roots: Iterable<string>,
): string[] {
  const dependents = reverseAdjacency(all);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    queue.push(root);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dep of dependents.get(cur) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen].sort();
}
