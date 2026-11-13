/** Canonical JSON + sha256 helpers. Pure; no I/O except file hashing. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON: sorted object keys (recursive), no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export async function hashFile(path: string): Promise<string> {
  const data = await readFile(path);
  return sha256Hex(data);
}

/**
 * Content hash for a decision record: sha256 over canonical JSON of every
 * authored field. Only the two derived fields (`review_state`, `decision_hash`)
 * are excluded, so an approval bound to this hash covers the exact decision
 * content a human reviewed (title, claims, evidence, artifacts, status, ...).
 */
export function computeAuthoredContentHash(decision: object): string {
  const { review_state: _rs, decision_hash: _h, ...authored } = decision as Record<string, unknown>;
  void _rs;
  void _h;
  return sha256Hex(canonicalJson(authored));
}

/**
 * Content hash for a gate record: authored fields only. `approval_digest` is
 * system-derived provenance (the digest of the consumed `gate_accept` record),
 * so it is excluded: the approval can be bound before the digest is stamped,
 * and acceptance can recompute the same hash from the stored gate.
 */
export function computeGateContentHash(gate: object): string {
  const { approval_digest: _ad, ...authored } = gate as Record<string, unknown>;
  void _ad;
  return sha256Hex(canonicalJson(authored));
}
