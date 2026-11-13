/**
 * Artifact checks: a closed vocabulary whose named checks are actually
 * executed. Failures are returned as verdicts (never thrown) so a validation
 * record can persist the evidence. `artifact_validate` writes the record;
 * acceptance re-verifies it against the current artifact hash/mtime.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { figcraftExport, figcraftInfo } from "./figcraft.js";

export const SUPPORTED_ARTIFACT_CHECKS = ["opens", "exports", "tokens-resolve"] as const;
export type ArtifactCheckVerdict = "pass" | "fail";

export interface ArtifactCheckResult {
  name: string;
  verdict: ArtifactCheckVerdict;
  detail: string;
}

export interface ArtifactCheckContext {
  /** Project root: the read root for info/export checks. */
  projectRoot: string;
  /** Exports root: writable parent for the exports check's temp output. */
  exportsDir: string;
  /** Test seam / external CLI override (defaults to the pinned figcraft-cli). */
  exe?: string;
}

function pass(name: string, detail: string): ArtifactCheckResult {
  return { name, verdict: "pass", detail };
}

function fail(name: string, detail: string): ArtifactCheckResult {
  return { name, verdict: "fail", detail };
}

function isFigcraftFile(file: string): boolean {
  return path.extname(file).toLowerCase() === ".figcraft";
}

async function checkOpens(file: string, ctx: ArtifactCheckContext): Promise<ArtifactCheckResult> {
  if (isFigcraftFile(file)) {
    try {
      const res = await figcraftInfo(file, { read: [ctx.projectRoot], write: [] }, ctx.exe);
      const info = res.info;
      if (info === null || typeof info !== "object") {
        return fail("opens", "figcraft info did not return an object");
      }
      const nodes = "nodes" in info ? info.nodes : undefined;
      return pass("opens", `figcraft info parsed${typeof nodes === "number" ? ` (nodes=${nodes})` : ""}`);
    } catch (err) {
      return fail("opens", `figcraft info failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const fh = await fs.open(file, "r");
    try {
      const st = await fh.stat();
      if (!st.isFile()) return fail("opens", "not a regular file");
      await fh.read(Buffer.alloc(1), 0, 1, 0);
    } finally {
      await fh.close();
    }
    return pass("opens", "file opens for reading");
  } catch (err) {
    return fail("opens", `cannot open: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkExports(file: string, ctx: ArtifactCheckContext): Promise<ArtifactCheckResult> {
  if (!isFigcraftFile(file)) {
    return fail("exports", "exports only applies to .figcraft artifacts");
  }
  const out = path.join(
    ctx.exportsDir,
    `.artifact-check-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.png`,
  );
  try {
    await fs.mkdir(ctx.exportsDir, { recursive: true });
    const res = await figcraftExport(
      { file, out, format: "png" },
      { read: [ctx.projectRoot], write: [ctx.exportsDir] },
      ctx.exe,
    );
    const st = await fs.stat(out);
    if (!st.isFile()) return fail("exports", "export produced no output file");
    return pass("exports", `exported ${res.files.length} file(s)`);
  } catch (err) {
    return fail("exports", `export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await fs.rm(out, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkTokensResolve(file: string, ctx: ArtifactCheckContext): Promise<ArtifactCheckResult> {
  if (!isFigcraftFile(file)) {
    return fail("tokens-resolve", "tokens-resolve only applies to .figcraft artifacts");
  }
  try {
    const res = await figcraftInfo(file, { read: [ctx.projectRoot], write: [] }, ctx.exe);
    const info = res.info;
    if (info === null || typeof info !== "object") {
      return fail("tokens-resolve", "figcraft info did not return an object");
    }
    const rec = info as Record<string, unknown>;
    const hasVariables = Object.hasOwn(rec, "variables");
    const hasStyles = Object.hasOwn(rec, "styles");
    if (!hasVariables && !hasStyles) {
      return fail("tokens-resolve", "info has no variables/styles tables");
    }
    return pass(
      "tokens-resolve",
      `token tables resolved (variables=${hasVariables ? "present" : "absent"}, styles=${hasStyles ? "present" : "absent"})`,
    );
  } catch (err) {
    return fail("tokens-resolve", `figcraft info failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Execute every recorded check. Unknown names are failed verdicts, never passes. */
export async function runArtifactChecks(
  artifactPath: string,
  checks: readonly string[],
  ctx: ArtifactCheckContext,
): Promise<ArtifactCheckResult[]> {
  const results: ArtifactCheckResult[] = [];
  const seen = new Set<string>();
  for (const name of checks) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === "opens") results.push(await checkOpens(artifactPath, ctx));
    else if (name === "exports") results.push(await checkExports(artifactPath, ctx));
    else if (name === "tokens-resolve") results.push(await checkTokensResolve(artifactPath, ctx));
    else results.push(fail(name, "unknown check"));
  }
  return results;
}

// ---- validation records ----------------------------------------------------

export const VALIDATION_RECORD_SCHEMA_VERSION = 1;

export interface ValidationRecord {
  schema_version: 1;
  decision_id: string;
  artifact_path: string;
  sha256: string;
  validator_version: number;
  results: ArtifactCheckResult[];
  validated_at: string;
  artifact_mtime_ms: number;
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * Stable on-disk name for a record. Acceptance scans the directory and matches
 * record contents, so the name is only an operator aid (not trusted).
 */
export function validationRecordName(decisionId: string, artifactPath: string, sha256: string): string {
  const base = path.basename(artifactPath).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "artifact";
  return `${decisionId}-${base}-${sha256.slice(0, 8)}.json`;
}

/** Strict parse of a stored record; malformed records are ignored by acceptance. */
export function parseValidationRecord(v: unknown): ValidationRecord | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.schema_version !== VALIDATION_RECORD_SCHEMA_VERSION) return null;
  if (typeof r.decision_id !== "string" || r.decision_id.length === 0) return null;
  if (typeof r.artifact_path !== "string" || r.artifact_path.length === 0) return null;
  if (typeof r.sha256 !== "string" || !SHA_RE.test(r.sha256)) return null;
  if (typeof r.validator_version !== "number" || !Number.isInteger(r.validator_version) || r.validator_version < 1) return null;
  if (typeof r.validated_at !== "string" || r.validated_at.length === 0) return null;
  if (typeof r.artifact_mtime_ms !== "number" || !Number.isFinite(r.artifact_mtime_ms)) return null;
  if (!Array.isArray(r.results)) return null;
  const results: ArtifactCheckResult[] = [];
  for (const item of r.results) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const x = item as Record<string, unknown>;
    if (typeof x.name !== "string" || x.name.length === 0) return null;
    if (x.verdict !== "pass" && x.verdict !== "fail") return null;
    if (typeof x.detail !== "string") return null;
    results.push({ name: x.name, verdict: x.verdict, detail: x.detail });
  }
  return {
    schema_version: 1,
    decision_id: r.decision_id,
    artifact_path: r.artifact_path,
    sha256: r.sha256,
    validator_version: r.validator_version,
    results,
    validated_at: r.validated_at,
    artifact_mtime_ms: r.artifact_mtime_ms,
  };
}
