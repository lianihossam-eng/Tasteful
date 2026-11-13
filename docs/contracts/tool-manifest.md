# Tool manifest (model tool set)

Owner: host. Version: 1. The model sees exactly these 12 tools — no `bash`,
`read`, `write`, `edit`, `eval`, `codemode`, `run_command`, or `batch`, and
no MCP tools.

| Tool | Params | Output | Approval |
|---|---|---|---|
| `fs_list` | `{ path: string }` (project-relative) | `{ entries: [{name, type}] }` | no |
| `fs_read` | `{ path: string, max_bytes?: number }` | `{ content, sha256, truncated }` — `sha256` is the **whole-file** hash; `content` is the first `max_bytes` | no |
| `fs_write` | `{ path: string, content: string }` | `{ sha256 }` — refuses an existing hardlinked target | yes (digest-bound, single-use) |
| `decision_get` | `{ id: string }` | decision JSON | no |
| `decision_upsert` | decision JSON (strict; `review_state`/`decision_hash` rejected) | `{ id, version, decision_hash }` | no; `accepted` needs a consumed human approval record + passing gate |
| `decision_invalidate` | `{ claim_id, old_value, new_value, reason, author }` | `{ event_id, affected }` | no |
| `artifact_validate` | `{ decision_id, artifact_path }` | `{ ok, expected, actual, drifted?, affected?, results?, validation_record? }` — executes the recorded checks and writes a validation record | no |
| `artcraft_info` | `{ file: string }` | figcraft `info --json` | no |
| `artcraft_export` | `{ file, out, node?, format?, page?, scale? }` | `{ out, files, sha256 }` | yes (digest-bound, single-use) |
| `gate_get` | `{ gate_id: string }` | gate JSON | no |
| `gate_upsert` | gate JSON (strict; derived `approval_digest` rejected) | `{ gate_id }` | no; a model may create/update only absent or non-pass gates and may write `pending`/`fail`, never `pass`/`revoked`; any agent write touching a stored pass gate → `E_GATE_HUMAN_ONLY`; a human non-pass write over a stored pass is also `E_GATE_HUMAN_ONLY` (revoke-only) |
| `run_journal_read` | `{ seq_from?: number, limit?: number }` | `{ entries, ok }` | no |

## fs policy (all `fs_*` + artifact paths)

*   Resolve with `realpath`. Allowlist: `projectRoot` and `exportsRoot`
    (`<project>/.tasteful/exports`).
*   **State roots are revalidated on every operation** (`assertStateRoots`):
    `lstat` of `.tasteful` and each existing child root; any symlink →
    `E_PATH_SYMLINK` (even if it targets inside the project); a regular file
    where a directory belongs → `E_PATH`; `realpath(.tasteful)` must equal
    `<realpath(project)>/.tasteful`; `realpath(exports)` must stay inside
    `realpath(project)` (`E_PATH_ESCAPE`). A root swapped after `init` fails
    every write.
*   **Agent state is never reachable**: a resolved path equal to
    `realpath(agentDir())` (`~/.tasteful/agent`, `TASTEFUL_HOME` honored) or
    a descendant → `E_PATH_ESCAPE`, including when the project root is
    `HOME`.
*   Reject: absolute paths outside roots, `..` escapes, symlinks resolving
    outside roots, `/proc`, `/sys`, `/dev`, and `$HOME/.pi`.
*   Hardlinked regular files are rejected on read **and write**
    (`lstat().nlink > 1` → `E_PATH_HARDLINK`); the write check repeats inside
    the write lock. `fs_list` is exempt.
*   `fs_read` caps `content` at `max_bytes` (default 256 KiB, hard 1 MiB) but
    hashes the **whole file** (all bytes) as `sha256`; `truncated` is true iff
    the file is longer than `max_bytes`. Files above the 8 MiB full-hash cap
    → `E_PATH_TOO_LARGE`. `fs_write` is capped at 1 MiB.
*   **Reserved state is never writable through model paths**: anything at or
    under `.tasteful/decisions`, `.tasteful/journal`, `.tasteful/approvals`,
    `.tasteful/events`, `.tasteful/gates`, `.tasteful/validations`,
    `.tasteful/.lock` → `E_PATH_RESERVED`, even with a matching approval. The
    reserved prefix is compared against `realpath(.tasteful)`, so a project
    path that is itself a symlink cannot alias reserved state. State changes
    go through the specialized tools/store writer.
*   `fs_write` / `artcraft_export` require an approval record bound to
    `sha256(canonical(tool + target + content/argv + params))`; after grant,
    re-resolve + recompute before acting (TOCTOU); mismatch or a moved
    target refuses. Approval ids are basenames only (digest or
    `<digest32>.json`) resolved inside `.tasteful/approvals/`; other paths
    are rejected with `E_APPROVAL_PATH`. Operation approvals report changed
    target/content/params as `E_APPROVAL_MUTATED`; content-bound
    decision/gate approvals report `E_APPROVAL_MISMATCH`.
*   Headless/test default: deny. Human grants come from `tasteful approve
    --grant|--deny`, `accept`, `gate accept`, or the `fs write` CLI flow.

## Decision invariants exposed by tools

*   `decision_get`/`gate_get` validate ids (`^D[0-9]+$` /
    `^G-[A-Z0-9][A-Z0-9-]*$`) before building a path, assert the path stays
    in the decisions/gates directory, and verify the stored id matches the
    requested id.
*   `decision_upsert` rejects authored `review_state` and `decision_hash`
    (`E_SCHEMA`). The system writer recomputes `decision_hash`, and
    `readDecision` verifies it (`E_HASH_MISMATCH` on tamper). Ordinary updates
    preserve the stored `review_state`.
*   `accepted` requires owner, ≥1 evidence with sha256 (file refs resolve and
    hash-match; `E_ACCEPT_NO_EVIDENCE`), ≥1 artifact passing checks in this
    order (`E_ACCEPT_NO_ARTIFACT`): `ready !== false`; parseable
    `validated_at`; non-empty `checks`; each check in the closed
    `opens`/`exports`/`tokens-resolve` vocabulary (failed/prefixed labels are
    unsupported); `validator_version: 1`; path resolves as a regular file and
    hash-matches; `validated_at` no older than the file mtime (mtime-only
    touch is stale); then a matching **passing** validation record under
    `.tasteful/validations/` with the same sha256, validator version, and
    check-name set, all verdicts `pass`, and a `validated_at` no older than
    the file mtime. It also requires a passing
    `gate_ref` whose stored gate carries an `approval_digest` resolving to the
    consumed `gate_accept` record for that gate content (missing/invalid
    provenance → `E_GATE_BLOCKED`), and a consumed `decision_accept` approval
    from a non-owner whose `content_hash` equals
    `computeAuthoredContentHash(submitted decision)`. Validation runs before
    the approval is consumed.
*   **Re-review:** submitting `accepted` through `decision create
    --approval` with a fresh approval is the only transition from
    `stale`/`needs_review`/`invalidated`/`blocked` to `current` (and sets
    artifacts `ready: true`). `artifact_validate` reports `OK`/`DRIFT` but
    does not clear `review_state`.
*   `artifact_validate` on a matching hash executes the recorded checks and
    writes `.tasteful/validations/<decision>-<basename>-<sha8>.json`. All
    checks passing sets `validated_at`/`checks` and `ready: true`; a failed,
    inapplicable, or unknown check applies the drift demotion (owner +
    dependents `needs_review`, `accepted` → `proposed`, `ready: false`) with
    reason `checks-failed`, and the failed record remains as evidence.
*   `artifact_validate` drift: owner + every transitive reverse-`depends_on`
    dependent become `needs_review`; any `accepted` status is demoted to
    `proposed`; all their artifacts get `ready: false`; the journal records
    the drift and **no** validation record is written. No automatic
    re-acceptance.
*   `gate_upsert`: the model actor cannot set `decision: "pass"` or
    `"revoked"`, and cannot modify an existing stored pass gate (even to
    `pending`/`fail`) — `E_GATE_HUMAN_ONLY`. A human-authored non-pass over a
    stored pass is also `E_GATE_HUMAN_ONLY` ("use gate revoke"); only
    `gate revoke` may demote a pass. `pass` → `pass` with changed content
    needs a fresh consumed `gate_accept` approval for the new content
    (digest restamped). The human CLI `gate create` path validates
    passability and a consumed `gate_accept` approval before writing
    (`E_GATE_NO_APPROVAL` when missing), stamps the consumed digest as
    `approval_digest`, and a rejected gate is never persisted.
    `gate revoke --id <G> --approver <email>` is human-only: stored gate must
    pass, approver must differ from the gate owner under canonical identity
    (`E_SELF_APPROVAL`), and every accepted decision citing `G` is demoted to
    `proposed`/`needs_review` with `ready: false` artifacts before the
    revoked gate is written.
*   **Identity.** `decision.owner`, `gate.owner`, `gate.approver`, and
    `waiver.owner` are stored verbatim; empty or leading/trailing whitespace
    is `E_SCHEMA`. Self-approval and provenance checks use canonical identity
    (NFKC + trim; email domain lowercased with local-part case preserved;
    other ids whole-lowercase). CLI `--approver` is canonicalized before the
    grant.
*   **Journal preflight.** State-changing tools verify the hash-chained
    journal after state-root revalidation and before consuming an approval or
    mutating state; a corrupt/missing-on-nonempty/empty-with-state journal is
    `E_JOURNAL_CORRUPT` with no change and no consumed approval. A fresh
    project's missing/blank journal starts at `seq: 1`.

## Approval grammar

Approvals are single-use records under `.tasteful/approvals/`. An id is the
64-hex digest or a `<digest32>.json` basename; anything else is
`E_APPROVAL_PATH`. `operationDigest = sha256(canonical(tool, target,
content, params, toolVersion))`.

| Approval | tool | target | content_hash | params |
|---|---|---|---|---|
| fs write / export | `fs_write` / `artcraft_export` | resolved target / out path | operation content (file content / canonical argv) | tool params |
| decision accept | `decision_accept` | decision id | `computeAuthoredContentHash(decision)` (all authored fields; excludes `review_state`/`decision_hash`) | `{approver}` |
| gate pass | `gate_accept` | gate id | `computeGateContentHash(gate)` (authored gate fields; excludes derived `approval_digest`) | `{approver}` |

Consumption errors: no/corrupt/denied record → `E_APPROVAL_DENIED`; already
used → `E_APPROVAL_REPLAY`; path id → `E_APPROVAL_PATH`; operation-approval
payload/target changes → `E_APPROVAL_MUTATED`; content-bound
decision/gate content or approver changes → `E_APPROVAL_MISMATCH`; approver
equals owner → `E_SELF_APPROVAL`.

Canonical accept order: finalize the accepted-shape decision JSON
(`status: accepted`, `gate_ref`, evidence with hashes, artifacts with
`checks`/`validator_version: 1`) → run `tasteful validate --decision <D>
--artifact <path>` for every artifact until it prints `OK` (fresh passing
validation record) → rebuild the authored file from the refreshed stored
record (remove derived `review_state`/`decision_hash`) → `tasteful accept
--file <json> --approver <email>` (or `accept --decision <D>` for an unchanged
stored record) → `tasteful decision create --file <same json> --approval
<digest>`. `accept` evaluates neither gate nor artifacts; `decision create`
does, before consuming the approval.

Canonical gate-pass order: `tasteful gate accept --file <json> --approver
<email>` (first-time pass) or `gate accept --id <G>` (stored gate) →
`tasteful gate create --file <same json> --approval <digest>` (stamps the
consumed digest as `approval_digest`). A human `gate revoke --id <G>
--approver <email>` sets `decision: "revoked"` and demotes accepted
dependents; re-acceptance needs a fresh pass + approval.

## Registration

Tools are `defineTool()` definitions in `src/host/registration.ts`, passed
as `customTools` to `createAgentSession`, and also registered through the
product inline extension (`src/host/product-loader.ts`) so extension-level
hooks (`before_provider_headers`) run.
`createAgentSession` receives the explicit allowlist
`tools: [...PRODUCT_TOOL_NAMES]` — exactly the 12 names above. An empty
allowlist is not used: it disables custom tools too (SDK `allowedToolNames`
semantics). `session.getActiveToolNames()` is asserted equal to the manifest
in `tests/unit/contracts.test.ts`, and the documented session-option subset is
returned as `SessionHandles.sessionOptions` and asserted there (`cwd`,
`agentDir`, settings instance/flags, loader constructor, tool allowlist,
session-manager kind, runtime auth path, model id, custom-tool names, thinking
level).
