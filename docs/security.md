# Tasteful — security model (MVP)

## Tool removal

The model tool set is exactly the 12 product tools in
`docs/contracts/tool-manifest.md`. `createAgentSession` receives
`tools: [...PRODUCT_TOOL_NAMES]` — the explicit product allowlist. An empty
allowlist is not used: the SDK would also disable custom tools.
`customTools` contains only product definitions, no MCP extension is added,
and `session.getActiveToolNames()` is asserted equal to the manifest in
`tests/unit/contracts.test.ts`.

## Resource loader / hermeticity

*   The product uses `ProductResourceLoader` (`src/host/product-loader.ts`),
    a custom `ResourceLoader` with **zero discovery and zero filesystem
    calls**. It never constructs a package manager, so it cannot enumerate
    or stat `.pi`, `.agents`, `~/.agents`, `AGENTS.md`, or `CLAUDE.md`.
*   `getExtensions()` returns exactly one synthetic inline extension
    (`<inline:tasteful-tools>`). Its `handlers`/`tools` are populated by
    running `productToolsExtension(reg)` against a minimal `ExtensionAPI`
    shim that implements only `on` and `registerTool`; any other API method
    throws. Skills, prompts, themes, and agents files are empty, the system
    prompt is the product prompt, and append prompts are empty.
*   Settings are always an explicit in-memory `SettingsManager`
    (`compaction`/`retry` off, `enableInstallTelemetry: false`) shared by the
    loader and the session; no settings file is read.
*   Evidence has two layers: poison tests
    (`tests/hermetic/poison.test.ts`) plant marker files/directories and
    assert no extension executes and no marker text reaches loader/session
    output; `tests/hermetic/loader-strace.test.ts` runs the compiled bin
    under `strace -f` for `status` and `run --model mock` and asserts **zero**
    `openat`/`statx`/`stat`/`lstat` trace lines containing `.pi/` or
    `.agents/`. The strace test skips with an explicit reason when `strace`
    is unavailable; the syscall claim is not made from the poison test alone.
*   `src/bin.ts` is the package `bin`: its only static import is the
    Node-builtins-only env helper. It captures a set `PI_PACKAGE_DIR`, calls
    `scrubProcessEnv()` **before** the dynamic `cli.js` import, and prints
    exactly `TASTEFUL: ignoring PI_PACKAGE_DIR=<value>` to stderr. The value
    is never used for identity or discovery. `scrubProcessEnv()` deletes every
    `PI_*` variable, `AI_AGENT`, and every non-`TASTEFUL_*` `*_CONTROL_PORT`
    from `process.env`; `childEnv()` applies the same prefix rule to spawned
    children. Ordinary environment variables (PATH, HOME, …) still pass so
    tools run.
*   Sessions/auth/settings resolve under `TASTEFUL_HOME` (or the OS home) in
    `~/.tasteful/agent` only; `~/.pi` is never read for behavior and never
    written. Session persistence is in-memory by default; file-backed
    sessions are opt-in (`inMemorySession: false`).

## Provider identity

`enableInstallTelemetry: false` makes the SDK's client identity carry no
pi attribution. The product extension registers a
`before_provider_headers` handler (`applyProductIdentityHeaders`) that
replaces any `User-Agent` with `tasteful/<version>` and sets pi's
attribution header names to `null` (the SDK's delete marker). Evidence:
`tests/unit/contracts.test.ts` asserts telemetry is off in the assembled
session; an offline header test asserts the transformation. This is not a
wire-level test against a real provider.

## Filesystem confinement

*   `realpath` + allowlist (`projectRoot`, `.tasteful/exports`). Rejects:
    absolute paths outside roots, `..` escapes, escaping symlinks, `/proc`,
    `/sys`, `/dev`, and `$HOME/.pi`.
*   **State-root revalidation on every operation.** `assertStateRoots` runs
    at the top of `withLock` (every locked state change), before
    `resolveProjectPath` resolves a tool path, and at init:
    `lstat` of `.tasteful` and each existing child root
    (`decisions`, `gates`, `events`, `approvals`, `journal`, `exports`,
    `validations`);
    a symlinked root is `E_PATH_SYMLINK` (even if the target stays inside
    the project), a regular file where a directory is expected is `E_PATH`,
    `realpath(.tasteful)` must be exactly
    `<realpath(project)>/.tasteful`, and `realpath(exports)` must stay inside
    `realpath(project)` (`E_PATH_ESCAPE`). A root swapped after `init` fails
    every write before touching the target (`tests/unit/state-roots.test.ts`).
*   **Agent-state exclusion.** After realpath/allowlist, a resolved path
    equal to `realpath(agentDir())` (`~/.tasteful/agent`, honoring
    `TASTEFUL_HOME`) or a descendant is rejected with `E_PATH_ESCAPE`. This
    applies to `fs_list`/`fs_read`/`fs_write`, artifact paths, and the model
    adapter source/output tools. Running with the project root equal to
    `HOME` (or `TASTEFUL_HOME` equal to the project) does not refuse init, but
    agent state remains unreadable/unwritable to the model.
*   Hardlinked regular files are rejected on read **and write**
    (`E_PATH_HARDLINK`, `lstat().nlink > 1`; the write check runs again
    inside the write lock). `fs_list` and the adapter export target are not
    hardlink-checked.
*   `fs_read` returns at most `max_bytes` (default 256 KiB, hard 1 MiB), but
    `sha256` is always the **whole-file SHA-256** over all bytes, so it
    matches `artifact_validate`/`hash --file`; `truncated` reports whether
    content was cut. Files above the 8 MiB full-hash cap fail
    `E_PATH_TOO_LARGE`. `fs_write` is capped at 1 MiB.
*   Reserved state: `.tasteful/decisions`, `.tasteful/journal`,
    `.tasteful/approvals`, `.tasteful/events`, `.tasteful/gates`,
    `.tasteful/validations`, `.tasteful/.lock` (and descendants) are never
    writable through model `fs_write`/`artcraft_export` paths, even with an
    approval (`E_PATH_RESERVED`). The check compares the resolved target
    against `realpath(.tasteful)`, so a project path that is itself a symlink
    cannot alias reserved state. State goes through the specialized
    tools/store writer.
*   Writes (`fs_write`, `artcraft_export`) need a digest-bound single-use
    approval; the target is re-resolved after approval (TOCTOU) and any
    change refuses.

## Approvals

*   `operationDigest(tool + target + content + params + toolVersion)`; records
    live under `.tasteful/approvals/` (`<digest32>.json`) and are single-use.
    Replay (`E_APPROVAL_REPLAY`), denied records (`E_APPROVAL_DENIED`),
    path/absolute/`..` ids (`E_APPROVAL_PATH`), and payload changes are
    rejected. Operation approvals (`fs_write`/`artcraft_export`) report a
    changed target/content/params as `E_APPROVAL_MUTATED`; content-bound
    decision/gate approvals report `E_APPROVAL_MISMATCH`. Approval ids are a
    64-hex digest or a `<digest32>.json` basename resolved only inside the
    approvals directory.
*   Headless/test default: deny. Human grants happen via the working CLI:
    `approve --grant|--deny --tool <t> --target <tgt> --content <text>|
    --content-file <f> [--params-json <json>] [--approver <email>]`, or the
    `accept`/`gate accept` flows below.
*   **Decision acceptance** binds the submitted decision content, not just
    the id: tool `decision_accept`, target `<decision id>`, `content_hash =
    computeAuthoredContentHash(decision)` (sha256 of canonical JSON over all
    authored fields; excludes only `review_state` and `decision_hash`),
    params `{approver}`. `accept (--decision <D> | --file <json>) --approver
    <email>` prints the digest: `--decision` binds the current stored,
    hash-verified record; `--file` binds that exact authored JSON. Exactly
    one is required; `accept` evaluates neither gate nor artifacts.
*   **Gate pass** binds the gate content: tool `gate_accept`, target
    `<gate_id>`, `content_hash = computeGateContentHash(gate)` (sha256 of
    canonical JSON over the authored gate fields; the derived
    `approval_digest` is excluded), params `{approver}`. `gate accept
    (--id <G> | --file <json>) --approver <email>` prints the digest;
    `gate create --file <json> --approval <digest>` is required when the
    gate `decision` is `pass` (`E_GATE_NO_APPROVAL` when missing,
    `E_APPROVAL_MISMATCH` when changed/transferred, `E_APPROVAL_REPLAY` on
    replay) and stamps the consumed digest into the stored gate.
    Non-pass gates need no approval. `gate revoke --id <G> --approver
    <email>` is human-only, requires a stored pass gate, rejects canonical
    `sameIdentity(approver, owner)`, sets `decision: "revoked"`, and demotes
    accepted decisions citing `G`.
*   **Identity canonicalization (normative).** Every owner/approver
    comparison uses `sameIdentity(a, b)`, i.e. equality of
    `canonicalIdentity(value)`: NFKC-normalize, then trim; if the result is
    email-shaped (exactly one `@`, non-empty local part and domain, no
    whitespace) lowercase the **domain only** and preserve the local-part
    case, which is technically significant; otherwise lowercase the whole
    trimmed value (role/display ids such as `"Lead Operator"`). Empty after
    trim is rejected. Authored identity fields (`decision.owner`,
    `gate.owner`, `gate.approver`, `waiver.owner`) are stored verbatim and
    an empty or leading/trailing-whitespace value is `E_SCHEMA` — values are
    never silently rewritten, so content hashes stay stable. CLI
    `--approver` input is trimmed/canonicalized before the grant, so
    `" Lead@EXAMPLE.com "` and `"Lead@example.com"` are the same approver,
    `"User@x"` and `"user@x"` are not (local-part case), and
    `"User@EXAMPLE.com"` and `"User@example.com"` are. NFKC also equates
    `"e\u0301"` with `"é"`.
*   Brief text is never an approval. Self-approval (`sameIdentity(approver,
    owner)`) is rejected for **passing** gates and decision acceptance
    (`E_SELF_APPROVAL`, also at gate revoke); non-pass gates may be authored
    by their owner, and acceptance cannot use them.
*   The model cannot pass or revoke a gate: `gate_upsert` with
    `decision: "pass"`/`"revoked"` throws `E_GATE_HUMAN_ONLY`, and any agent
    write touching an existing stored pass gate (even `pending`/`fail`) is
    also `E_GATE_HUMAN_ONLY`. Only the human CLI `gate create` path may write
    a passing gate, and it validates passability and the gate approval before
    writing.
*   **A stored pass gate is immutable except through `gate revoke`.** A
    human-authored `gate create`/upsert that changes a stored pass gate to
    `pending`, `fail`, or `revoked` is `E_GATE_HUMAN_ONLY` ("use gate
    revoke"); `revoked` itself is writable only by the human
    `gate revoke --id <G> --approver <email>` transition, which requires a
    stored pass, compares `approver != owner` canonically, demotes accepted
    dependents before writing the gate, and journals `gate_revoke`.
    `pass` → `pass` is allowed only with a **fresh** consumed `gate_accept`
    approval bound to the new gate content (the digest is restamped);
    missing/mutated/replayed approval follows the normal
    `E_GATE_NO_APPROVAL`/`E_APPROVAL_MISMATCH`/`E_APPROVAL_REPLAY` rules.

## Accepted decisions

`accepted` requires all of:

*   non-empty owner;
*   ≥1 evidence entry, each with a 64-hex `sha256`; a project-relative (or
    in-project absolute) `ref` must resolve under the roots, exist, and
    hash-match (`E_ACCEPT_NO_EVIDENCE` otherwise). URL-scheme refs
    (`scheme://`, e.g. `http(s)://`) or absolute outside-project refs are
    accepted on the recorded hash only and journal a not-file-verified
    warning;
*   ≥1 artifact; acceptance checks each artifact in this order, all under
    `E_ACCEPT_NO_ARTIFACT`:
    1.  `ready === false` → "not ready" (before any filesystem work);
    2.  missing `validated_at` or an unparseable date;
    3.  `checks` missing/empty → "lacks validation checks";
    4.  any check outside the closed `opens`/`exports`/`tokens-resolve`
        vocabulary (including failed/prefixed labels such as `fail` or
        `opens:failed`) → "unsupported check";
    5.  `validator_version !== 1`;
    6.  path resolution under project roots, regular-file check, and
        hash-match against the recorded `sha256`;
    7.  freshness: `validated_at` must be no older than the file's floored
        mtime (an mtime-only touch after validation is stale even when the
        bytes/hash are unchanged) → "validation is stale";
    8.  a matching **passing validation record** under
        `.tasteful/validations/`: same `sha256`, validator version, and
        check-name set, every verdict `pass`, and record `validated_at` no
        older than the file mtime → otherwise "no passing validation
        record". A bare `ready:true` claim is never sufficient. The record
        is written only by an actual `artifact_validate` run over the
        current bytes; failed/inapplicable runs keep a failed record and
        demote instead.
    `tests/unit/artifact-checks.test.ts` exercises one flipped dimension per
    branch and asserts the branch-specific message.
*   a `gate_ref` whose stored gate passes **and** carries an
    `approval_digest` resolving to the consumed granted `gate_accept` record
    for that gate content/target/approver; legacy or hand-written pass gates
    without provenance are `E_GATE_BLOCKED`;
*   a **consumed** human `decision_accept` approval from a non-owner
    (canonical identity) whose `content_hash` equals the submitted decision's
    authored content hash.

Artifact/evidence/gate validation runs before the approval is consumed, so a
failed submission leaves state unchanged and does not burn the approval. No
self-approval, no automatic re-acceptance after invalidation or drift.

## Re-review

There is exactly one transition back to `current`: submit the decision as
`accepted` via `decision create --approval` with a **fresh** unused
content-bound approval, a passing gate with its own approval, and artifacts
that re-resolve and re-hash clean at that moment. If the stored
`review_state` was `stale`/`needs_review`/`invalidated`/`blocked`, the store
sets `review_state: "current"` and every artifact `ready: true` after the
hash check. If an artifact drifted, the write is refused
(`E_ACCEPT_NO_ARTIFACT`) and state is unchanged. A standalone `validate`
that prints `OK` does not clear `review_state`; no other automatic clear
exists.

## Artifact integrity

`decision_hash` over canonical authored content is recomputed on every
system write and verified on read (`E_HASH_MISMATCH`); decision filename/id
binding is enforced. `artifact_validate` executes the recorded checks for a
matching hash and writes
`.tasteful/validations/<decision>-<basename>-<sha8>.json`: an all-pass run
sets `validated_at`/`checks` and `ready: true`; a failed, inapplicable, or
unknown check applies the drift demotion (owner + every transitive
reverse-`depends_on` dependent `needs_review`, any `accepted` → `proposed`,
all their artifacts `ready: false`, reason `checks-failed`) and keeps the
failed record as evidence. On hash drift no validation record is written.
A re-check reports `OK` but does not clear `review_state`; only the accepted
re-review submission in `docs/operator.md` does.

## Journal

Append-only JSONL, hash-chained (`prev_hash`, `payload_hash`), written by the
host/CLI only. The model has `run_journal_read`, which verifies the chain and
throws `E_JOURNAL_CORRUPT` instead of returning tampered entries.

*   **Leaf.** `lstat` first: a symlinked or non-regular `run.jsonl` is
    `E_JOURNAL_LEAF` on read/append/verify. An unreadable leaf (e.g.
    `EACCES` from `readFile`) surfaces as that error rather than being
    folded into corruption: `status.journal_error` reports it verbatim, and
    the model-facing `run_journal_read` wraps any verification failure as
    `E_JOURNAL_CORRUPT`.
*   **Lines.** Blank or whitespace-only lines are skipped silently. Every
    non-blank line must JSON-parse to a non-null, non-array object with an
    integer `seq >= 1`; otherwise verification throws `E_JOURNAL_CORRUPT`
    naming the 1-based line number. Unknown extra entry fields are allowed on
    read for forward compatibility (emitted entries still match the v1
    contract); they do not participate in `payload_hash`.
*   **Empty state.** A missing journal (`ENOENT`) is healthy only while the
    project has no decisions, gates, or change events; the first append then
    writes `seq: 1`. An existing zero-byte or whitespace-only journal on such
    an empty project is also a healthy fresh start (the first append replaces
    the blank file with `seq: 1`). Once state exists, a missing journal — and
    an existing empty/whitespace-only journal — is `E_JOURNAL_CORRUPT`: a
    chain may never restart at `seq: 1` over surviving state. Only these
    empty/missing cases and line/chain breakage below are
    `E_JOURNAL_CORRUPT`; ordinary I/O errors such as `EACCES` surface as
    their own error.
*   **Shape.** Entries must be contiguous from `seq: 1` with `prev_hash`
    chaining from `GENESIS` and a recomputed `payload_hash`; any break is
    `E_JOURNAL_CORRUPT`. There is no internal length cap: appends derive
    `seq` from the last entry + 1 and verification covers the full chain at
    any length.
*   **Preflight ordering.** Every state-changing locked path verifies the
    journal at the top of the critical section, after state-root
    revalidation and before any approval consumption or mutation:
    `fs_write`, `decision_upsert`, `gate_upsert`/`gate revoke`,
    `decision_invalidate`, `artifact_validate`, and `brief`. A corrupt,
    missing-on-nonempty, empty-with-state, unreadable, or symlinked journal
    therefore aborts with no state change and **no consumed approval**.
    `init` creates the state roots and is exempt; `appendJournal` repeats the
    empty-state guard defensively under the same lock.
*   `status --json` reports `journal_ok: false` plus `journal_error` when
    verification fails (it never hardcodes true).

## Status honesty

`status` is a read-only diagnostic and does not fail closed on partial data.
It reports the decisions it can read, then gates per file: a missing gates
directory is simply `gates: []`; a gate file that cannot be read or
validated (malformed JSON, schema violation, or id mismatch) is collected
as `gate_errors: [{ file, error }]` while readable gates are still listed.
`gate_errors` is present only when non-empty; the human output prints
`gates: X ok, Y errors` plus a `gate error: <file>: <message>` line per
failure. Journal failure is reported as `journal_ok: false`,
`journal_seq: -1`, and `journal_error`. Both cases still exit 0 with an
honest body, matching the journal flag pattern rather than treating a
diagnostic as a state-changing command.

## Change events

`event_id` is `E-<UTC day>-<nnn>`. The sequence is
`max(numeric suffix of existing event files for that day) + 1` — not the
file count, so gaps never cause reuse (with `E-…-001` and `E-…-003` present,
the next id is `E-…-004`; `003` is untouched). A defense-in-depth existence
check refuses an existing target with `E_EVENT_EXISTS` (exit 3). Claim/closure
validation runs before the event file is written, so a rejected invalidation
leaves no event file and consumes no id.

## Journal lock discipline

State-changing commands (`init`, `brief`, `decision create`, `invalidate`,
`validate`, `gate create`, `gate revoke`, `accept`, `approve`, and the store
writers) verify and append their journal entry while holding the project
lock. `fs_write` appends **inside** its write lock (journal preflight,
approval consumption, TOCTOU re-resolve, atomic write, and journal append are
one critical section); `journalAdapterRun` takes the project lock for its
append; the post-session `run` command also appends under `withLock`.
`appendJournal` re-reads the tail, computes `seq`/`prev_hash`, and appends
under that same lock, so concurrent writers serialize. The chain is
re-verified on every read, so a torn or tampered append is detected
(`journal_ok:false` / `E_JOURNAL_CORRUPT`).

## Adapter

*   Fixed executable `figcraft-cli` + literal argv; no shell; argv elements
    with shell metacharacters are rejected.
*   `--automation-read-root` / `--automation-write-root` always attached;
    `info` gets read roots only.
*   Operations allowlist: `info`, `export` only. Anything else fails
    pre-execution with `E_NOT_ALLOWLISTED`.
*   `requirePinnedPair()` runs `<exe> --version` + `commands` before **every**
    `info`/`export` spawn; a non-`0.14.0` pair fails closed with
    `E_UNSUPPORTED_PAIR` and no output write. The successful pair is cached
    per process keyed by resolved executable path.
*   `adapter check` reports `canaryOk: false` unless a `--canary` fixture was
    actually run and parsed.
*   Writes: 0 automatic retries. Reads: ≤2 retries, idempotent only.

## Residual risks (not solved in MVP)

1.  `realpath` + allowlist + per-operation state-root checks + agent-state
    exclusion + hardlink/symlink checks contain an honest-but-fallible model,
    not a truly hostile one (kernel races, fd tricks beyond the blocklist,
    local-root attacker). Production deployment should add OS-level
    sandboxing.
2.  Evidence refs that are `http(s)://` or absolute outside the project are
    accepted on their recorded `sha256` without re-downloading; the journal
    marks them not file-verified. The threat model does not include a
    network fetcher.
3.  No MCP in the MVP: the MCP-poisoning surface is absent rather than
    defended. Enabling MCP later requires the pinned-manifest policy from
    the build plan.
4.  Approval records live in the project directory; a local attacker with
    write access to `.tasteful/` can forge grants. The threat model is
    model-confinement, not local-root.
5.  Provider identity is overridden at the extension boundary and tested
    offline; no real provider request is sent in the MVP.
