/** Assert a rejection/throw carries an E_* code (message or .code). */
import assert from "node:assert/strict";

export function codeOf(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      const m = message.match(/E_[A-Z_]+/);
      if (m) return m[0];
      return message;
    }
  }
  return String(err);
}

export async function rejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err !== null, `expected rejection with ${code}, but it resolved`);
  assert.equal(codeOf(err), code);
}

export function throwsWithCode(fn: () => unknown, code: string): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err !== null, `expected throw with ${code}, but it returned`);
  assert.equal(codeOf(err), code);
}
