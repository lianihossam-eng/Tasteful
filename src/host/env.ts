/**
 * Env scrub: children and this process see no ambient agent-control state.
 * Rule (prefix-based, not an enumerated list): drop every `PI_*` variable,
 * `AI_AGENT`, and any non-product `*_CONTROL_PORT`. `TASTEFUL_*` product
 * variables and ordinary environment variables pass through unchanged.
 */

const CONTROL_PORT_SUFFIX = "_CONTROL_PORT";

/** True when a variable is ambient agent control state and must not leak. */
export function isScrubbedEnvKey(key: string): boolean {
  if (key.startsWith("PI_")) return true;
  if (key === "AI_AGENT") return true;
  // Control ports are cross-product ambient controls; only TASTEFUL_* is ours.
  const upper = key.toUpperCase();
  if (upper.endsWith(CONTROL_PORT_SUFFIX) && !key.startsWith("TASTEFUL_")) return true;
  return false;
}

/** Delete scrubbed vars from process.env in place. */
export function scrubProcessEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (isScrubbedEnvKey(k)) delete process.env[k];
  }
}

/** Build a child env: current env minus scrubbed vars, plus explicit extras. */
export function childEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (isScrubbedEnvKey(k)) continue;
    out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!isScrubbedEnvKey(k)) out[k] = v;
    }
  }
  return out;
}
