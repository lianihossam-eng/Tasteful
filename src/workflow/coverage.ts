/** Coverage matrix helpers: validation + required-state rules. */
import { SchemaError, validateCoverage, type CoverageMatrix } from "../design/schema.js";

/** States that must always be considered (in or explicitly out with rationale). */
const ALWAYS_CONSIDERED = ["default", "error", "loading", "empty"];

/**
 * Validate structural schema plus the "always considered" rule: for screens
 * whose name suggests checkout/payment flows, error/loading/empty states must
 * appear or the screen must be explicitly out with a rationale.
 * Returns warnings (non-fatal) so operators stay in control.
 */
export function checkCoverage(input: unknown): { matrix: CoverageMatrix; warnings: string[] } {
  const matrix = validateCoverage(input);
  const warnings: string[] = [];
  for (const s of matrix.screens) {
    const critical = /checkout|payment|pay|cart|panier|paiement/i.test(s.screen);
    if (!critical || s.decision === "out") continue;
    for (const st of ALWAYS_CONSIDERED) {
      if (!s.states.includes(st)) {
        warnings.push(`screen '${s.screen}': critical flow without '${st}' state`);
      }
    }
  }
  if (matrix.platforms.length === 0) throw new SchemaError("coverage: no platforms");
  return { matrix, warnings };
}
