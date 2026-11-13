# Tasteful — operator guide

## Install

```sh
cd tasteful
npm install
npm run build
```

Node ≥ 20. No global installs. `figcraft-cli 0.14.0` must be on `PATH` for
adapter commands; any other version fails closed with `E_UNSUPPORTED_PAIR`
before an operation runs.

## Quick start (temp project)

From a checkout, invoke the env-first launcher directly:
`node dist/src/bin.js` (the package `bin` points there). `dist/src/cli.js` is
a library module and does not self-execute, so running it prints nothing.
After `npm link`/install, `tasteful` resolves to the same launcher.

```sh
export TASTEFUL_HOME="$(mktemp -d)/home"
PROJ="$(mktemp -d)/proj"
BIN="node dist/src/bin.js"
$BIN --project "$PROJ" init --name demo
$BIN --project "$PROJ" brief --file brief.md --coverage coverage.json
$BIN --project "$PROJ" decision create --file D001.json
$BIN --project "$PROJ" adapter check --canary "$PWD/canary.figcraft"
$BIN --project "$PROJ" export --file "$PROJ/tiny.figcraft" --out .tasteful/exports/a.png --format png
$BIN --project "$PROJ" status --json
```

`adapter check` without `--canary` is valid but reports `canary=false`; the
canary is a read-only `info` parse, not a write.

## Commands

See `tasteful --help` (product output only). Key flows:

*   **Accepted decision (canonical order).** Acceptance is content-bound, so
    the human approves the exact canonical authored content (key order and
    whitespace do not change the digest):
    1.  Finalize the decision JSON in its accepted shape: `status:
        "accepted"`, `owner`, `gate_ref`, evidence refs with `sha256`, and
        artifacts each with `path`, `sha256`, `validator_version: 1` and an
        applicable `checks` list (`opens`/`exports`/`tokens-resolve`;
        `exports`/`tokens-resolve` are `.figcraft`-only). Project-relative
        evidence/artifact paths must exist under the project and hash-match.
        Owner/approver identity is compared canonically: NFKC + trim, domain
        lowercased for email shapes (local-part case preserved), whole value
        lowercased for display ids. `"Lead@EXAMPLE.com"` equals
        `"Lead@example.com"`; `"User@x"` does **not** equal `"user@x"`.
        Authored `owner`/`approver` fields are stored verbatim and rejected
        with `E_SCHEMA` if empty or padded with whitespace; `--approver` CLI
        input is trimmed/canonicalized before the grant (e.g.
        `accept --approver ' Lead@EXAMPLE.com '` grants for
        `Lead@example.com`).
    2.  Create/confirm the passing gate first (see below); its approval and
        content-bound provenance are independent.
    3.  Run `tasteful validate --decision D001 --artifact <path>` for every
        artifact until it prints `OK`. This executes the recorded checks and
        writes a fresh `.tasteful/validations/…` record; acceptance rejects
        missing, failed, or stale records and any artifact modified after
        validation. Because validate refreshes the stored artifact's
        `validated_at`/`checks`/`ready`, rebuild `D001.json` from the stored
        record (drop derived `review_state`/`decision_hash`) before approving.
    4.  `tasteful accept --file D001.json --approver lead@example` prints a
        64-hex digest bound to that JSON. Use `accept --decision D001` only
        when re-approving the currently stored record unchanged; any later
        change to the decision content (title, claims, evidence, artifacts,
        version, gate_ref, status) invalidates the digest
        (`E_APPROVAL_MISMATCH`).
    5.  `tasteful decision create --file D001.json --approval <digest>`.
        Artifact (`sha256` + mtime vs the passing validation record),
        evidence, and gate provenance validation run before the approval is
        consumed; failures leave state unchanged and do not burn the grant.
        Replay is `E_APPROVAL_REPLAY`; missing/fabricated/inapplicable
        artifact or stale/missing validation record is
        `E_ACCEPT_NO_ARTIFACT`; missing/unhashable evidence is
        `E_ACCEPT_NO_EVIDENCE`.
*   **Re-review.** After invalidation or drift, correct the decision,
    re-`validate` every artifact (fresh passing record), and submit it as
    `accepted` with a **fresh** `accept` approval (repeat steps 4–5). That
    accepted write is the only way `stale`/`needs_review`/`invalidated`
    becomes `current` and artifacts return to `ready: true`. A passing
    `validate` does not re-review.
*   **Gate pass.** For a human-written `decision: "pass"`:
    `tasteful gate accept --file G-DESIGN-REVIEW.json --approver
    lead@example` (first-time pass) or `gate accept --id <G>` (stored gate;
    the file name must equal the declared `gate_id`) prints the digest; then
    `tasteful gate create --file <same json> --approval <digest>`, which
    stamps the consumed digest as `approval_digest`. Missing approval is
    `E_GATE_NO_APPROVAL`; changed gate content is `E_APPROVAL_MISMATCH`.
    Non-pass gates need no approval; a submitted `approval_digest` is
    `E_SCHEMA`. The model cannot write `pass`/`revoked`, cannot modify a
    stored pass gate, and a pass gate without provenance cannot satisfy
    acceptance (`E_GATE_HUMAN_ONLY`/`E_GATE_BLOCKED`).
    A stored pass is immutable except through `gate revoke`: submitting
    `pending`/`fail` (or `revoked`) over it is `E_GATE_HUMAN_ONLY` with
    "use gate revoke", for humans too. `pass` → `pass` with changed content
    is allowed only with a **fresh** `gate accept` approval for the new
    content; the consumed digest is restamped. Only `gate revoke`
    demotes the gate (and its accepted dependents).
*   **Gate revoke.** `tasteful gate revoke --id G-DESIGN-REVIEW --approver
    lead@example` is human-only: it requires a stored pass gate, rejects the
    gate owner as approver (`E_SELF_APPROVAL`, canonical comparison), sets
    `decision: "revoked"`, and demotes every accepted decision citing it to
    `proposed`/`needs_review` with `ready: false` artifacts. Dependents are
    demoted before the revoked gate is written. Re-acceptance requires a
    fresh gate pass + gate approval and a fresh decision approval.
*   **Record evidence/exports:** `tasteful export --file <fig> --out
    .tasteful/exports/x.png --node "<frame>" --format png` prints
    `<file> <sha256>` lines.
*   **Apply a scope change:** `tasteful invalidate --claim C-X --old a --new
    b --reason "..." --author you@example` prints the event id and
    `D... <state>` lines. States are normative: direct hits `stale` (a
    validation decision — accepted with `gate_ref` — is `invalidated`),
    reverse dependents `needs_review` (`invalidated` for validation
    decisions), decisions outside the closure unchanged. The event id is
    `E-<UTC day>-<nnn>` where `nnn` is the maximum existing suffix for that
    day plus one (with `001` and `003`, the next is `004`; `003` is never
    reused). An existing target is refused with `E_EVENT_EXISTS`; a rejected
    invalidation writes no event and consumes no id.
*   **Check an artifact:** `tasteful validate --decision D001 --artifact
    .tasteful/exports/x.png` re-hashes, executes the recorded checks, and
    writes `.tasteful/validations/<D>-<basename>-<sha8>.json`. It prints
    `OK ...` (all checks pass), `DRIFT ... affected=...` (hash mismatch; drift
    transition, no record), or `CHECKS-FAILED ...` (failed/inapplicable check;
    owner + dependents `needs_review`, accepted→proposed, `ready:false`, failed
    record kept). Run it before `accept`; a passing validate alone does not
    clear `review_state`.
*   **Interactive approvals:**
    `tasteful approve --list` lists granted, unused records.
    `tasteful approve --grant --tool fs_write --target <abs target>
    --content "text" [--params-json '{"path":"..."}'] [--approver
    email]` prints the digest; `--content-file <f>` is the file alternative.
    `tasteful approve --deny` with the same flags writes a denied record at
    the same digest (deny wins; `--list` then excludes it).
*   **Agent run:** `tasteful run --prompt "..." --model mock` is a
    deterministic agent-wiring smoke (fixed scripted `run_journal_read`
    tool call); it does not reason from the prompt. Real-model CLI wiring is
    not part of the MVP.
*   **Status:** `tasteful status [--json]` reports decisions with
    `status`/`review_state`/artifact `ready`, gates, and journal health. A
    missing gates directory is `gates: []`; an unreadable or invalid gate
    file (malformed JSON, schema violation, id mismatch) is
    reported as `gate_errors: [{ file, error }]` while readable gates stay
    listed (`gate_errors` appears only when non-empty; the text form prints
    `gates: X ok, Y errors` plus a `gate error: <file>: <message>` line per
    failure). Journal failure is `journal_ok: false`,
    `journal_seq: -1`, and `journal_error`; status still exits 0 because it
    is a diagnostic, not a fail-closed state mutation.

## Test and hermetic operation

*   `TASTEFUL_BRIM=<path>` points the fixture-dependent integration/e2e tests at
    an optional read-only fixture. When unset, the tests **skip with an
    explicit reason** (`BRIM fixture missing (TASTEFUL_BRIM unset); set
    TASTEFUL_BRIM`); `npm run e2e` prints `E2E-CLI SKIP` and exits 0. Never
    point it at a file you expect the suite to modify: the fixture is
    read-only input and the e2e asserts its hash.
*   `TASTEFUL_HOME=$(mktemp -d)` isolates agent state (`~/.tasteful/agent`).
    The suite also redirects `HOME` in the loader/hermetic tests so ambient
    `~/.agents/skills` cannot influence them; the `strace` test asserts no
    open/stat of `.pi` or `.agents` at the syscall level (it skips with an
    explicit reason when `strace` is unavailable).
*   Tests never read or write the real `~/.pi`, `assets/`, `exports/`, or
    the BRIM file.

## Environment diagnostics

*   **`PI_PACKAGE_DIR`.** The launcher (`dist/src/bin.js`, also the
    `tasteful` bin) scrubs `PI_*`/`AI_AGENT` before any SDK import. If
    `PI_PACKAGE_DIR` was set, it prints exactly
    `TASTEFUL: ignoring PI_PACKAGE_DIR=<value>` to stderr and continues; the
    value never affects identity, paths, or discovery. It is a diagnostic,
    not an error — exit status is unchanged.
*   **Project root equal to `HOME`.** `init` succeeds and the project stays
    usable, but `~/.tasteful/agent` (credentials, models, sessions) is
    excluded from every fs/artifact/adapter path (`E_PATH_ESCAPE`). The same
    exclusion applies when `TASTEFUL_HOME` equals the project root. Prefer a
    dedicated project directory; the guard exists so the model cannot read
    provider credentials.
*   **State-root swaps.** If `.tasteful` or one of its child roots is
    replaced by a symlink after `init`, every state/write command refuses
    with `E_PATH_SYMLINK` before touching the target; re-`init` or remove the
    symlink.

## Files

*   Project state: `<project>/.tasteful/` (decisions, gates, events,
    approvals, journal, exports, validations). Roots are revalidated (`lstat`
    + `realpath`) on every operation; symlinked roots are refused. Safe to
    commit except `approvals/` if your policy says so. Model
    `fs_write`/`artcraft_export` cannot write
    `.tasteful/{decisions,journal,approvals,events,gates,validations,.lock}`
    (the reserved check compares the real state root, so a symlinked project
    path cannot bypass it).
*   Agent state: `~/.tasteful/agent/` (sessions, auth, models, settings).
    Override the home for tests with `TASTEFUL_HOME`. Sessions are in-memory
    by default in the product test/run paths. This subtree is never readable
    or writable through model tools, even when the project root is `HOME`.
*   `~/.pi` is never opened/stat'ed for behavior. Uninstall = delete the
    project dir + `~/.tasteful` (your data; no hidden state elsewhere).

## Exit codes

0 ok · 2 usage · 3 validation/confinement-detail (see `E_*` code) ·
4 confinement · 5 unsupported adapter version · 6 project locked.

## Troubleshooting

*   `E_UNSUPPORTED_PAIR`: `figcraft-cli 0.14.0` is required; every
    `info`/`export` performs the pinned-pair check before spawning.
*   `E_LOCK_BUSY`: another command holds `.tasteful/.lock`; stale locks
    (dead pid) are reaped automatically.
*   `E_APPROVAL_DENIED` / `E_APPROVAL_REPLAY` / `E_APPROVAL_MUTATED` /
    `E_APPROVAL_MISMATCH` / `E_APPROVAL_PATH`: grant a fresh approval for
    this exact operation via `approve --grant` (or `accept`/`gate accept`),
    and pass its digest or approvals-directory basename.
    `E_APPROVAL_MUTATED` (operation approvals) or `E_APPROVAL_MISMATCH`
    (decision/gate content approvals) means the target/content/params/
    approver changed after the grant; re-approve the final bytes.
*   `E_ACCEPT_NO_ARTIFACT` / `E_ACCEPT_NO_EVIDENCE`: an accepted submission
    cited `ready:false`, a missing/unparseable `validated_at`, empty
    `checks`, an unknown check label (including failed/prefixed labels), an
    unsupported `validator_version`, a missing/unresolvable/unhashed
    artifact, a hash mismatch, a validation older than the artifact mtime,
    or no matching passing record in `.tasteful/validations/`. Fix the
    file/record (`validate` first), then re-approve the final decision.
    `E_ACCEPT_NO_APPROVAL`: the accepted write had no consumed
    `decision_accept` approval (headless model path).
*   `E_GATE_BLOCKED`: the gate is not passing, evidence is missing, the gate
    is `revoked`, or a pass gate lacks valid `approval_digest` provenance.
    `E_GATE_NO_APPROVAL`: a passing gate needs `gate accept` +
    `gate create --approval`. `E_SELF_APPROVAL`: approver equals owner under
    canonical identity (revoke included; non-pass gates may be authored by
    the owner). `E_SCHEMA`: an authored owner/approver is empty or has
    leading/trailing whitespace; store the exact identity, not a padded one.
*   `E_GATE_HUMAN_ONLY`: a model attempted `gate_upsert` with
    `decision:"pass"`/`"revoked"` or touched an existing stored pass gate; a
    human tried to change a stored pass to `pending`/`fail`/`revoked`
    without `gate revoke`; or `gate create` authored `revoked`. Use the
    human `gate accept`/`gate create`/`gate revoke` CLI; only `gate revoke`
    may demote a stored pass.
*   `E_EVENT_EXISTS`: the computed change-event target already exists
    (defense in depth; ids are max-suffix+1). Re-run invalidation; no event
    was overwritten and no id was consumed.
*   `E_ARTIFACT_CHECKS`: `validate` executed the recorded checks and at
    least one failed or does not apply to the file type; the owner and
    dependents are `needs_review`, accepted is `proposed`, and the failed
    record is retained. Fix the artifact/checks and re-validate.
*   `E_PATH_RESERVED`: the target is reserved `.tasteful` state; use the
    decision/gate/journal tools instead of `fs_write`.
*   `E_PATH_SYMLINK`: a state/export root was replaced by a symlink after
    init (or is one at init); restore a real directory.
*   `E_PATH_HARDLINK`: the target has multiple links; use a regular file.
*   `E_PATH_TOO_LARGE`: the file exceeds the 8 MiB full-hash read cap.
*   `E_PATH_ESCAPE` on `~/.tasteful/agent`: the project root is `HOME` (or
    `TASTEFUL_HOME` equals the project); agent state is deliberately
    unreadable. Use a dedicated project directory.
*   `E_HASH_MISMATCH`: a decision file was hand-edited without updating
    `decision_hash`; rewrite it through `decision create` or restore it.
*   `journal_ok:false` in `status --json`: the run journal failed
    verification (broken seq/hash, invalid JSON line or entry shape,
    symlink/non-regular `run.jsonl`, unreadable file, a missing journal, or
    an empty/whitespace-only journal, once the project holds
    decisions/gates/events); inspect `journal_error` before trusting journal
    evidence. On a fresh project a missing or blank journal is healthy.
    `E_JOURNAL_LEAF` names a replaced/non-regular journal file; restore a
    regular `run.jsonl`. An unreadable leaf (`EACCES`) is reported verbatim,
    not folded into corruption. State-changing commands preflight the journal
    before mutating state or consuming an approval, so a failed preflight
    aborts the command cleanly with its journal error (no state change, no
    consumed approval).
