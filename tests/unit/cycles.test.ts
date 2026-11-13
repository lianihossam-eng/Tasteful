/** Cycle rejection: direct, indirect, self. */
import assert from "node:assert/strict";
import test from "node:test";
import { findCycle } from "../../src/design/store.js";
import type { Decision } from "../../src/design/schema.js";
import { decisionBase } from "../helpers.js";

function graph(pairs: Array<[string, string[]]>): Map<string, Decision> {
  const m = new Map<string, Decision>();
  for (const [id, deps] of pairs) m.set(id, decisionBase(id, { depends_on: deps }));
  return m;
}

test("acyclic graph has no cycle", () => {
  assert.equal(findCycle(graph([["D001", []], ["D002", ["D001"]], ["D003", ["D002"]]])), null);
});

test("direct 2-cycle is found", () => {
  const c = findCycle(graph([["D001", ["D002"]], ["D002", ["D001"]]]));
  assert.ok(c && c.length === 3);
});

test("indirect cycle is found", () => {
  const c = findCycle(graph([["D001", ["D003"]], ["D002", ["D001"]], ["D003", ["D002"]]]));
  assert.ok(c && c[0] === c[c.length - 1]);
});

test("self-edge is found", () => {
  const c = findCycle(graph([["D001", ["D001"]]]));
  assert.deepEqual(c, ["D001", "D001"]);
});
