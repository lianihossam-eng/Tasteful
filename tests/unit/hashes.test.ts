/** Hash stability: canonical JSON, decision_hash coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../../src/design/hashes.js";
import { computeDecisionHash, validateDecision } from "../../src/design/schema.js";
import { decisionBase } from "../helpers.js";

test("canonical JSON is stable under key reorder", () => {
  const a = canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } });
  const b = canonicalJson({ a: { c: "x", d: [3, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,2]},"b":1}');
});

test("sha256 of known vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("decision_hash excludes review_state and decision_hash", () => {
  const d = decisionBase("D001", {
    claims: [{ claim_id: "C-A", subject: "s", predicate: "is", value: "v", scope: "project" }],
  });
  const h1 = computeDecisionHash({ ...d, review_state: "current" });
  const h2 = computeDecisionHash({ ...d, review_state: "stale", decision_hash: "0".repeat(64) });
  assert.equal(h1, h2);
});

test("decision_hash changes when authored content changes", () => {
  const d = decisionBase("D001");
  const h1 = computeDecisionHash(d);
  const h2 = computeDecisionHash({ ...d, title: "Different" });
  assert.notEqual(h1, h2);
});

test("unknown fields are rejected", () => {
  assert.throws(() => validateDecision({ ...decisionBase("D001"), bogus: 1 }), /unknown field/);
});

test("self-edge is rejected", () => {
  assert.throws(() => validateDecision({ ...decisionBase("D001"), depends_on: ["D001"] }), /self-edge/);
});
