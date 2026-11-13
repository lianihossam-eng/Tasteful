/**
 * Owner/approver identity canonicalization.
 *
 * Normative rule (mirrored in docs/security.md):
 *   1. Unicode NFKC normalize, then trim.
 *   2. Email-shaped values (`local@domain`, exactly one `@`, non-empty local
 *      and domain, no whitespace) lowercase the DOMAIN only. The local part
 *      is technically case-sensitive per RFC 5321, so it is preserved:
 *      `" Lead@EXAMPLE.com "` -> `"Lead@example.com"`.
 *   3. Any other value (role/display id such as `"Lead Operator"`) lowercases
 *      the whole trimmed value, so display casing never defeats the
 *      self-approval check.
 *   4. Empty after trim throws `IdentityError` (code E_SCHEMA, `empty
 *      identity`). Authored owner/approver content is never rewritten, so
 *      content hashes stay stable; only CLI approval input is normalized.
 *
 * `sameIdentity` is the single comparison used for self-approval checks
 * (decision accept, gate accept/create provenance, gate revoke, gate pass).
 */
export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

export function canonicalIdentity(raw: string): string {
  if (typeof raw !== "string") throw new IdentityError("E_SCHEMA", "identity: expected string");
  const trimmed = raw.normalize("NFKC").trim();
  if (trimmed.length === 0) throw new IdentityError("E_SCHEMA", "empty identity");
  const at = trimmed.indexOf("@");
  if (EMAIL_SHAPE.test(trimmed) && at === trimmed.lastIndexOf("@")) {
    return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
  }
  return trimmed.toLowerCase();
}

/**
 * Canonical equality of two identities. False when either side is empty after
 * trim (grant paths reject empties earlier, so this never weakens a check).
 */
export function sameIdentity(a: string, b: string): boolean {
  try {
    return canonicalIdentity(a) === canonicalIdentity(b);
  } catch {
    return false;
  }
}

/** Throw E_SELF_APPROVAL when both values canonicalize to the same identity. */
export function assertNotSelf(approver: string, owner: string, message = "approver must differ from owner"): void {
  if (sameIdentity(approver, owner)) throw new IdentityError("E_SELF_APPROVAL", message);
}
