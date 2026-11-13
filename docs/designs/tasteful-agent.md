# Tasteful — Hermetic Product-Design Agent on the pi SDK

*   **Status:** Implemented MVP (hardened through independent review)
*   **Date:** 2026-11-11
*   **Sources:** the approved internal build plan (not included in the public
    repository); `concepts_brief.md`; pi 1.5.2 SDK docs + installed `.d.ts`;
    verified `figcraft-cli 0.14.0` surface (`info`, `export`, `commands`,
    `--version`).

## Overview

Tasteful is a product-design agent that keeps an explicit, typed decision
graph next to the design work and drives FigCraft operations through a
confined adapter. It is a **hermetic host** built on the pi 1.5.2 SDK engine:
Tasteful owns its package, binary, paths, sessions, settings, tools,
approvals, identity, and update channel; pi provides only the agent loop,
tool execution, model runtime, and session primitives. No pi CLI/TUI runs at
runtime.

The MVP proves one vertical slice end to end against an optional read-only
FigCraft fixture supplied via `TASTEFUL_BRIM`: init a project, author
decisions D001–D007 with
typed claims and evidence, export a frame, enforce gates with non-owner
approval, apply a scope change with the plan's exact closure, detect artifact
mutation by hash, and run a real pi session with a deterministic mock model
through the product tool set.

## Problem Statement

Design decisions live in prose and scattered files. When scope changes (for
example, adding a native iOS app to a mobile-web project), earlier choices
are silently invalidated, rationale is lost, and design files evolve without
a hash-linked record of what was approved and why. Teams need:

1.  Authored decisions with typed claims, evidence, alternatives, and status.
2.  Deterministic invalidation when a claim changes, propagated transitively
    to dependents.
3.  Evidence-linked acceptance: no `accepted` without owner, hashed evidence,
    an artifact that exists and hash-matches its record, a passed human-gated
    gate, and a consumed human approval bound to the decision content.
4.  Artifact integrity: a modified export must flip its decision and its
    dependents back to review and clear readiness.
5.  A confined agent runtime that can inspect and export design files without
    shell access, generic command execution, or ambient config discovery.

## Goals

1.  Ship a runnable Node.js + TypeScript package `tasteful-agent` with binary
    `tasteful`, pinned to `@earendil-works/pi-coding-agent@1.5.2` (exact),
    with `@earendil-works/pi-ai@1.5.2` and `typebox` declared as direct
    dependencies.
2.  Hermetic host: explicit `cwd`, `agentDir` (`~/.tasteful/agent`), project
    state (`.tasteful/`), `SettingsManager.inMemory`, `SessionManager`,
    `ModelRuntime`, product `ResourceLoader`, tool allowlist, and model. No
    behavioral use of `~/.pi`, `.pi`, `.agents`, `AGENTS.md`, `CLAUDE.md`,
    `PI_*`, `AI_AGENT`, pi.dev identity, or pi auto-update.
3.  Product tool set only: `fs_list`, `fs_read`, `fs_write` (approval),
    `decision_get`, `decision_upsert`, `decision_invalidate`,
    `artifact_validate`, `artcraft_info`, `artcraft_export`, `gate_get`,
    `gate_upsert`, `run_journal_read`. No `bash`, `write`, `edit`, `eval`,
    `codemode`, `run_command`, or `batch` in the model tool set.
4.  Decision core: schema v1, typed claims, `depends_on` as the only authored
    edge, derived review state, change events, the exact transitive closure,
    artifact hashes and drift propagation, gates, atomic writes, project
    lock, cycle rejection, rebuildable `index.json`, verified
    `decision_hash`.
5.  FigCraft CLI adapter: fixed executable + argv, no shell, confinement
    roots, `info` + `export`, pinned-pair handshake before every spawn.
    The fixture stays read-only.
6.  Approval store: operation digest, single-use, deny-by-default in
    headless/test, TOCTOU re-check after approval. No brief text counts as
    approval. Human CLI `approve --grant|--deny` works.
7.  Run journal: versions, hashes, mode, roots, steps, errors; model cannot
    write it; status reports verification failure honestly.
8.  Runnable proof: `npm run build`, `npm test`, `npm run e2e` pass; the
    optional fixture scenario runs from the CLI in a temp project with temp
    HOME; verification evidence is kept locally and is not published.

## Non-Goals (MVP)

*   VectorCraft, PhotoCraft, EffectCraft production support.
*   MCP transport for FigCraft (optional behind the same adapter interface;
    not required for the MVP).
*   GraphRAG, embeddings, or any learned retrieval. Phase 1 is lexical /
    metadata lookup plus edge traversal.
*   GUI attach (`--attach`), display/Xvfb harness.
*   Telemetry, auto-update, sharing, multi-user auth, migration from `~/.pi`.
*   Real-model CLI wiring; the MVP CLI runs the mock wiring smoke only.
*   Confirmatory evaluation (8–12 briefs is exploratory); blind-rating
    harness is out of the MVP.
*   OS-level sandboxing against a hostile model (documented residual risk).

## Proposed Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Tasteful CLI (product)                                      │
│  init · status · brief · decision · invalidate · gate ·     │
│  validate · adapter · export · info · approve · accept ·    │
│  fs · run · hash                                            │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ Hermetic host (product)                                     │
│  paths ~/.tasteful + .tasteful · env scrub · identity       │
│  SettingsManager.inMemory · SessionManager(explicit)        │
│  ModelRuntime(explicit auth/models paths)                   │
│  product ProductResourceLoader (zero discovery)             │
│  tool allowlist (12 product tools) · approvals · journal    │
└───────┬───────────────────┬───────────────────┬─────────────┘
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼─────────────┐
│ pi 1.5.2 engine│  │ Decision core  │  │ FigCraft adapter    │
│ agent loop     │  │ claims · edges │  │ fixed argv · roots  │
│ tool exec      │  │ index · hashes │  │ handshake · journal │
│ model runtime  │  │ gates · events │  │ info · export       │
└────────────────┘  └────────────────┘  └───────────────────┘
```

### Component layout (single package)

```text
tasteful/
  package.json                      # tasteful-agent, bin tasteful, exact pins
  tsconfig.json
  concepts_brief.md
  README.md
  docs/
    designs/tasteful-agent.md       # this document
    adr/0001-runtime.md
    contracts/decision-schema.json
    contracts/change-event-schema.json
    contracts/gate-schema.json
    contracts/coverage-matrix-schema.json
    contracts/run-journal-schema.json
    contracts/adapter-matrix.md
    contracts/tool-manifest.md
    security.md  operator.md  scope.md
  src/
    bin.ts                          # env-first launcher: scrub before SDK import
    cli.ts                          # argv dispatch (library; runCli)
    version.ts                      # package.json version + installed pi assert
    cli/identity.ts                 # product help/version strings
    cli/commands.ts                 # CLI command implementations
    host/paths.ts                   # TASTEFUL_HOME + ~/.tasteful/agent
    host/env.ts                     # PI_*/AI_AGENT/control-port scrub (no SDK import)
    host/session.ts                 # createAgentSession assembly, explicit
    host/product-loader.ts          # zero-discovery ResourceLoader (inline ext only)
    host/resources.ts               # product settings + system prompt
    host/registration.ts            # 12 defineTool defs + extension + UA headers
    host/models.ts                  # ModelRuntime + faux mock model
    host/tools.ts                   # product tool implementations
    host/approvals.ts               # digest, single-use, basename resolution
    host/journal.ts                 # hash-chained append/verify/read
    design/schema.ts                # strict types/validators; derived fields
    design/store.ts                 # atomic writes, lock, index, hash verify
    design/invalidate.ts            # closure + reverse dependents
    design/gates.ts                 # gate validation (owner≠approver, evidence)
    design/identity.ts              # identity canonicalization + sameIdentity
    design/hashes.ts                # canonical JSON, sha256, content hashes
    artcraft/figcraft.ts            # fixed-argv adapter: info/export
    artcraft/matrix.ts              # pinned pair, requirePinnedPair, canary
    artcraft/validate.ts            # check executors + validation-record parser
    workflow/coverage.ts            # coverage matrix validation
    workflow/run.ts                 # deterministic CLI wiring smoke
  tests/
    helpers.ts                      # temp dirs, decisionBase, TASTEFUL_BRIM
    assert-code.ts                  # error-code assertions
    fixtures/decisions.ts           # shared D001–D007 closure graph
    fixtures/generate.ts            # tiny deterministic .figcraft fixture
    unit/*.test.ts                  # closure, store, approvals, gates, paths,
                                    # argv, handshake, contracts, review-state,
                                    # hashes, cycles, atomic-lock, state-roots,
                                    # artifact-checks (acceptance matrix), drift,
                                    # accept-content, journal-preflight,
                                    # journal-cap, identity-canonical, event-id
    hermetic/*.test.ts              # poison (.pi extension/env), identity,
                                    # loader strace, launcher/PI_PACKAGE_DIR
    integration/figcraft.test.ts    # BRIM read-only + tiny fixture
    e2e/scenario.test.ts            # full CLI BRIM scenario (child processes)
  scripts/e2e.sh
```

No `packages/*` split before contracts freeze. Future packages import only
public `index` files, never internals.

### Host configuration

| Boundary | Value |
|---|---|
| `cwd` | Project root (explicit) |
| `agentDir` | `~/.tasteful/agent` (`TASTEFUL_HOME` override) |
| `settingsManager` | `SettingsManager.inMemory({ compaction: off, retry: off, enableInstallTelemetry: false })`, shared by loader and session |
| `sessionManager` | `SessionManager.inMemory(projectRoot)` by default; `SessionManager.create(projectRoot, ~/.tasteful/agent/sessions)` only with `inMemorySession: false` |
| `modelRuntime` | `ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false })` under `~/.tasteful` |
| `resourceLoader` | product `ProductResourceLoader` (`src/host/product-loader.ts`): a custom `ResourceLoader` with zero discovery. `getExtensions()` returns exactly one synthetic inline extension (`<inline:tasteful-tools>`, handlers/tools from `productToolsExtension`); skills/prompts/themes/agents files are empty; system prompt is `TASTEFUL_SYSTEM_PROMPT`; `appendSystemPrompt` is `[]`. No `.pi`, `.agents`, `AGENTS.md`, or `CLAUDE.md` path is opened/stat'ed. |
| `settings` | the same `SettingsManager.inMemory(...)` instance passed to both loader and session (`compaction`/`retry` off, `enableInstallTelemetry: false`) |
| `tools` | explicit allowlist `[...PRODUCT_TOOL_NAMES]` (exactly the 12 product tools) |
| `customTools` | product `ToolDefinition[]` from `registration.ts` |
| `model` | explicit `Model` (faux mock in tests/CLI smoke) |
| `thinkingLevel` | `off` |

The installed pi version is read from its `package.json` and asserted equal to
the exact dependency pin at startup (`src/version.ts`); the product version is
read from our `package.json`.

Entry order is normative: `src/bin.ts` statically imports only
`src/host/env.ts` (Node builtins), captures a set `PI_PACKAGE_DIR`, calls
`scrubProcessEnv()`, prints exactly
`TASTEFUL: ignoring PI_PACKAGE_DIR=<value>` to stderr when it was set, and only
then dynamically imports `cli.js`. The SDK's `config` module reads
`PI_PACKAGE_DIR` at module evaluation, so scrubbing inside `cli.main()` is too
late; the launcher is the first code to run. The variable is ignored with a
diagnostic (never used for identity or discovery), and the product version
stays `tasteful 0.1.0`.

## Contracts

All contracts live in `docs/contracts/` with an owner, version, and
validation test (`tests/unit/contracts.test.ts`). The test parses all five
JSON files (title/version/owner), validates known-good and known-bad records
against each schema with a minimal in-test structural validator, asserts the
TypeScript validators agree for decisions/events/gates/coverage, parses the
adapter-matrix rows and compares them token-for-token with
`buildInfoArgv`/`buildExportArgv`, asserts the loader is inline-only, and
asserts the documented session-option subset: `cwd`, `agentDir`, the shared
settings instance and flags, `ProductResourceLoader`, the 12-tool `tools`
allowlist, `sessionManager` kind, the `modelRuntime` auth path, the model id,
the `customTools` names, and `thinkingLevel`. The exact `createAgentSession`
call itself is exercised by session assembly and the CLI e2e, not by that
contract test.

### Decision schema v1 (`decision-schema.json`)

```yaml
schema_version: 1
id: D002
version: 1
title: Navigation mobile
question: Quel modèle de navigation pour le site mobile ?
status: accepted            # proposed | accepted | superseded | rejected
review_state: current       # DERIVED, read-only: current | stale |
                            # needs_review | invalidated | blocked
owner: designer@example
created_at: 2026-11-11
updated_at: 2026-11-11
claims:
  - claim_id: C-PLATFORM-MOBILE
    subject: platform.mobile
    predicate: is
    value: mobile-web
    scope: project
    valid_from: 2026-11-11
depends_on: [D001]          # ONLY authored edge
supersedes: null            # id or null
evidence:
  - type: analytics
    ref: analytics/2026-10-mobile-nav.md
    sha256: "..."           # required for accepted
    captured_at: 2026-11-05
alternatives: [menu plein écran, barre d'onglets]
artifacts:
  - path: .tasteful/exports/nav-mobile.png
    sha256: "..."
    validator_version: 1
    validated_at: 2026-11-11T09:30:00.000Z
    checks: [opens]        # closed vocabulary: opens | exports |
                           # tokens-resolve; checks must apply to the file
                           # type (exports/tokens-resolve are .figcraft-only)
    ready: true             # false after invalidation, hash drift, or failed checks
rollback:
  to_version: 1
  steps: [restore D002 v1, mark artifacts needs_review]
gate_ref: G-DESIGN-REVIEW   # id or null
decision_hash: "..."        # DERIVED, read-only: sha256(canonical authored)
```

Rules:

*   `status` is authored; `review_state` and `decision_hash` are derived and
    rejected on authored input (`E_SCHEMA`). The system writer recomputes
    `decision_hash`; reads verify the hash (`E_HASH_MISMATCH`) and the
    filename/id binding. `review_state` is preserved on ordinary updates and
    only changes through closure, drift, or the re-review transition below.
*   `depends_on` is the only authored edge (`invalidates`/`validates` are
    derived views). Unknown fields are rejected; cycles are rejected.
*   **Identity.** Owner/approver fields (`decision.owner`, `gate.owner`,
    `gate.approver`, `waiver.owner`) are stored verbatim and must be
    non-empty with no leading/trailing whitespace (`E_SCHEMA`; values are
    never silently rewritten, preserving content hashes). Comparisons use
    `canonicalIdentity`: NFKC + trim; email-shaped values (`local@domain`)
    lowercase the domain only (local-part case is significant), all other
    values lowercase the whole trimmed value; empty canonical identity is
    rejected. CLI `--approver` is canonicalized before grant. Examples:
    `" Lead@EXAMPLE.com "` → `"Lead@example.com"`, `"User@EXAMPLE.com"` ==
    `"User@example.com"`, `"User@x"` != `"user@x"`, `"e\u0301"` == `"é"`.
*   `accepted` requires: non-empty owner; ≥1 evidence entry with a 64-hex
    `sha256`; ≥1 artifact passing these checks in order (`E_ACCEPT_NO_ARTIFACT`
    on any failure): (1) `ready !== false`; (2) parseable `validated_at`
    present; (3) non-empty `checks`; (4) every check in the closed
    `opens`/`exports`/`tokens-resolve` vocabulary; (5) `validator_version: 1`;
    (6) path resolves under the project roots, is a regular file, and matches
    the recorded `sha256`; (7) `validated_at` is no older than the file's
    floored mtime (an mtime-only touch after validation is stale even with
    unchanged bytes/hash); (8) a matching **passing validation record** under
    `.tasteful/validations/` (same sha256, validator version, check-name set,
    all verdicts `pass`, and record `validated_at` no older than the file
    mtime). A bare `ready:true` claim is never sufficient.
    `tests/unit/artifact-checks.test.ts` flips one dimension per branch and
    asserts the branch-specific message. Then a `gate_ref` whose stored gate
    passes and carries provenance — an `approval_digest` resolving to the
    consumed `gate_accept` record bound to that gate's content — and a
    consumed human `decision_accept` approval from a non-owner (canonical
    identity) whose `content_hash` equals
    `computeAuthoredContentHash(submitted decision)` — not the owner string
    and not a bare decision id. Project-relative evidence refs must also
    resolve and hash-match (`E_ACCEPT_NO_EVIDENCE`); URL-scheme refs
    (`scheme://`, e.g. `http(s)://`) or absolute outside-project refs need
    the recorded hash only and journal a not-file-verified warning. Failures
    leave state unchanged and do not consume the approval.
*   **Re-review transition.** There is exactly one path from
    `stale`/`needs_review`/`invalidated`/`blocked` back to `current`: submit
    the decision as `accepted` via `decision create --approval` with a fresh
    unused content-bound approval, a passing gate, and artifacts that
    re-hash clean at that moment. The store then sets `review_state:
    "current"` and every artifact `ready: true`. A standalone `validate`
    that prints `OK` does not clear `review_state`; no other automatic clear
    exists. Drift refuses re-acceptance (`E_ACCEPT_NO_ARTIFACT`) and leaves
    state untouched.
*   Artifact hash drift flips the owner and reverse dependents to
    `needs_review`, demotes `accepted` to `proposed`, clears `ready`, and
    writes no validation record. `artifact_validate` on a matching hash
    executes the recorded checks and writes
    `.tasteful/validations/<decision>-<basename>-<sha8>.json`; an all-pass run
    sets `validated_at`/`checks` and `ready: true`, while any failed or
    inapplicable check (including an unknown name) applies the same demotion
    and propagation as drift with reason `checks-failed` and keeps the failed
    record as evidence. `validate` does not clear the review state by itself;
    re-acceptance with a fresh validation record and approval is the explicit
    re-review step.

### Change event schema v1 (`change-event-schema.json`)

```yaml
event_id: E-2026-11-11-001
claim_id: C-PLATFORM-MOBILE
old_value: mobile-web
new_value: mobile-web+ios
source: scope-change
occurred_at: 2026-11-11
reason: Le commanditaire ajoute une app iOS native.
author: designer@example
```

`event_id` is `E-<UTC day>-<nnn>`, where `nnn` is the maximum numeric suffix
among existing files for that day plus one (gap-safe: `001` + `003` → next
`004`, `003` untouched). Writing an existing target is refused with
`E_EVENT_EXISTS` as defense in depth. Claim/closure validation happens before
the event write, so a rejected invalidation leaves no event file and consumes
no id.

### Invalidation closure (normative, plan §5.5/H11)

Given a change event on `claim_id`:

1.  **Direct claim hits** (`claims[].claim_id == event.claim_id`) are
    `stale` — **except** validation decisions (`status === "accepted"` and
    `gate_ref != null`), which are `invalidated`.
2.  **Every transitive reverse-`depends_on` dependent** is `needs_review` —
    except validation decisions, which are `invalidated`.
3.  Decisions outside the closure stay unchanged (`current` unless they were
    already in another state).
4.  **Every artifact of every in-closure decision** gets `ready: false`.
5.  The event, affected ids, reason, and author are journaled. Nothing is
    automatically accepted.

There is no "direct hit that reaches another direct hit" exception: two
decisions referencing the same claim are both stale unless they are
validation decisions.

Golden fixture for `C-PLATFORM-MOBILE -> mobile-web+ios` (D001/D002 direct
non-gate hits; D003/D005 depend on D002; D006 accepted+gate; D004 standalone;
D007 depends on D004):

| D001 | D002 | D003 | D004 | D005 | D006 | D007 |
|---|---|---|---|---|---|---|
| stale | stale | needs_review | current | needs_review | invalidated | current |

No artifact of D001/D002/D003/D005/D006 remains `ready`; D004/D007 are
outside the closure and stay ready. This exact table is asserted by
`tests/unit/closure.test.ts` (in-memory) and by the CLI e2e.

### Artifact drift (normative, plan §5.4/H12)

`artifact_validate` recomputes sha256. On mismatch:

1.  The owner decision and every transitive reverse-`depends_on` dependent
    become `review_state: needs_review`.
2.  Any `accepted` status among the affected set is demoted to `proposed`;
    nothing remains accepted.
3.  All artifacts of the affected set get `ready: false`; the owner's drifted
    artifact records `validated_at` + a `sha256` check re-run attempt.
4.  The journal records the drift; the CLI prints
    `DRIFT <decision> <artifact>: expected=… actual=… affected=…`.
    A subsequent matching hash prints `OK …`. No automatic re-acceptance.
    Drift writes **no** validation record; on a matching hash the recorded
    checks execute and a record is written (a failed/inapplicable check
    follows the same demotion/propagation and prints `CHECKS-FAILED …`).

### Gate schema v1 (`gate-schema.json`)

```json
{
  "gate_id": "G-DESIGN-REVIEW",
  "stage": "visual-system",
  "checklist": [
    {
      "criterion": "contrast AA",
      "evidence_ref": "artifacts/contrast.json",
      "verifier_role": "accessibility",
      "verdict": "pass",
      "date": "2026-11-11"
    }
  ],
  "decision": "pass",
  "approver": "lead@example",
  "owner": "designer@example",
  "waivers": []
}
```

Rules: `approver != owner` for a stored `pass` gate (`E_SELF_APPROVAL`,
compared canonically); every checklist item needs a non-empty `evidence_ref`
+ `verdict: pass` for gate `pass` (`E_GATE_BLOCKED` otherwise); waivers
require owner + expiry + rationale; free-text "LGTM" is not a gate. The model
`gate_upsert` tool may create/update only absent or non-pass gates and may
write only `pending`/`fail` but **cannot** write `pass` **or** `revoked`, and
any agent write touching an existing stored `pass` gate (even
`pending`/`fail`) is `E_GATE_HUMAN_ONLY`.

**Stored pass immutability (human transition matrix).** A stored pass gate
is a durable record; only `gate revoke` may demote it.

| Stored | Submitted | Result |
|---|---|---|
| none | `pending`/`fail` | allowed, no approval |
| none | `pass` | allowed only with a consumed `gate_accept` approval bound to this content; digest stamped |
| none | `revoked` | `E_GATE_HUMAN_ONLY` (revoke transition only) |
| `pending`/`fail` | `pass` | consumed `gate_accept` approval required; digest stamped |
| `pass` | `pass` (same content) | allowed; approval still required and restamped (fresh grant) |
| `pass` | `pass` (changed content) | allowed only with a **fresh** `gate_accept` approval for the new content; digest restamped |
| `pass` | `pending`/`fail`/`revoked` without internal `allowRevoke` | `E_GATE_HUMAN_ONLY` "use gate revoke" (humans included) |
| `pass` | `revoked` via `gate revoke` only | allowed for a human, `approver != owner` canonically; accepted dependents demoted before the write |

`gate revoke` is the only path to `revoked`; `gate create` authoring
`revoked` is `E_GATE_HUMAN_ONLY`. Revoke journals `gate_revoke` and demotes
every accepted decision citing the gate to `proposed`/`needs_review` with
`ready: false` artifacts before writing the revoked gate.

A human-written `decision: "pass"` additionally requires a consumed
`gate_accept` approval: `gate accept (--id <G> | --file <json>) --approver
<email>` prints a digest whose content hash is
`computeGateContentHash(gate)` (sha256 of canonical JSON over the authored gate
fields; `approval_digest` is derived and excluded) and whose params are
`{approver}`; `gate create --file <json> --approval <digest>` is then
required and stamps the consumed digest into the stored gate as
`approval_digest`. Missing approval is `E_GATE_NO_APPROVAL`; changed content,
wrong target, or wrong approver is `E_APPROVAL_MISMATCH`; replay is
`E_APPROVAL_REPLAY`. `gate accept --file` supports first-time pass (nothing
needs to be stored yet); `gate accept --id` binds the currently stored gate
(id-bound: file name must equal the declared `gate_id`, else `E_SCHEMA`).
Non-pass gates need no approval; a submitted `approval_digest` is rejected
(`E_SCHEMA`). The human CLI validates passability before writing, so a
rejected gate is never persisted.

Decision acceptance requires the stored pass gate's `approval_digest` to
resolve to the consumed granted `gate_accept` record with matching target,
approver, and content hash; legacy/hand-written pass gates without provenance
are `E_GATE_BLOCKED`. `gate revoke --id <G> --approver <email>` is human-only:
it requires a stored pass gate, rejects canonical `approver == owner`
(`E_SELF_APPROVAL`), sets `decision: "revoked"`, and demotes every accepted
decision citing `G` to `proposed`/`needs_review` with `ready: false` artifacts
(journal event `gate_revoke`). Re-acceptance then needs the gate re-passed
through a fresh `gate accept` + `gate create --approval`, plus a fresh
`decision_accept` approval.

### Coverage matrix schema v1 (`coverage-matrix-schema.json`)

`brief_id`, `platforms`, `screens[]` with `screen`, `states`, `breakpoints`,
`decision` (`in`|`out`), `rationale`. Checkout/payment/error/empty/loading
states are always considered; a marketing page may stay single-state with
rationale. No "every state on every screen".

### Run journal schema v1 (`run-journal-schema.json`)

Append-only JSONL under `.tasteful/journal/run.jsonl`. Each entry: `seq`,
`ts`, `kind` (command | tool_call | approval | change_event | adapter |
gate | error), `actor` (human | agent | system), `payload` (canonical JSON),
`payload_hash`, `prev_hash`, `versions` (tasteful, pi, figcraft-cli), `roots`
(project/exports when applicable), `stderr_tail` (≤ 4 KiB).

*   **Leaf.** A symlink or any non-regular leaf (including a directory) is
    `E_JOURNAL_LEAF` on read/append/verify. An unreadable leaf (`EACCES`)
    surfaces as that error; `status.journal_error` reports it verbatim, and
    `run_journal_read` wraps any verification failure as `E_JOURNAL_CORRUPT`.
*   **Lines.** Blank/whitespace-only lines are skipped silently. Every
    non-blank line must JSON-parse to a non-null, non-array object with an
    integer `seq >= 1`; otherwise `E_JOURNAL_CORRUPT` names the 1-based line.
    Unknown extra entry fields are tolerated on read for forward
    compatibility; emitted entries still match the v1 contract.
*   **Empty state.** A missing journal (`ENOENT`) is healthy only while the
    project has no decisions/gates/events; the first append writes `seq: 1`.
    A zero-byte or whitespace-only journal is likewise a healthy fresh start
    on an empty project (the first append replaces it cleanly at `seq: 1`).
    Once state exists, a missing journal **or** an empty/whitespace-only
    journal is `E_JOURNAL_CORRUPT`; the chain never restarts at `seq: 1` over
    surviving state. Only these empty/missing cases and line/chain breakage
    are `E_JOURNAL_CORRUPT`; ordinary I/O errors such as `EACCES` surface as
    their own error.
*   **Chain.** The internal reader has **no** hidden cap: appends derive
    `seq` from the last entry + 1 and verify the full chain at any length
    (`prev_hash` from `GENESIS`; payload hashes recomputed). Any seq gap,
    `prev_hash` break, or payload-hash mismatch is `E_JOURNAL_CORRUPT`.
*   **Preflight.** Every state-changing locked path runs journal
    verification first, after state-root revalidation and before approval
    consumption or mutation: `fs_write`, `decision_upsert`, `gate_upsert`/
    `gate revoke`, `decision_invalidate`, `artifact_validate`, and `brief`.
    A corrupt/missing-on-nonempty/empty-with-state/unreadable/symlinked
    journal aborts with no change and no consumed approval (`init` creates
    state and is exempt; `appendJournal` defensively repeats the guard).
*   `status` returns `journal_ok:false` + `journal_error` (and
    `journal_seq: -1`); `run_journal_read` throws `E_JOURNAL_CORRUPT` after
    verifying the whole chain and applies its own `0..1000` result-limit
    clamp (default 200). `status` also reports gate read failures honestly:
    a missing `gates/` directory is `gates: []`; per-file read/validation
    failures (unreadable, malformed, schema-invalid, or id-mismatched) are
    collected as `gate_errors: [{file, error}]` (present only when non-empty)
    with readable gates still listed; the human form prints
    `gates: X ok, Y errors` plus one `gate error: <file>: <message>` line per
    failure. Status exits 0 with an honest body rather than failing
    closed.
    No model-writable path exists: tools expose `run_journal_read` only.

### Tool manifest (`tool-manifest.md`)

Exact names, JSON parameters, outputs, and approval class are in the
contract. All 12 tools are registered as `defineTool()` definitions and the
session uses the explicit `[...PRODUCT_TOOL_NAMES]` allowlist; no pi built-in
or MCP tool is active. `fs_write`/`artcraft_export` are digest-bound
single-use approvals; reserved `.tasteful` state directories (including
`validations`) are never writable through model paths (`E_PATH_RESERVED`),
with the real state root resolved via `realpath` before comparison so a
symlinked project path cannot alias reserved state, and approval ids are
basenames resolved under `.tasteful/approvals/`. `fs_read.sha256` is always
the whole-file hash (independent of `max_bytes`), and `fs_write` refuses an
existing hardlinked target (`E_PATH_HARDLINK`). `artifact_validate` executes
the recorded `opens`/`exports`/`tokens-resolve` checks, writes a validation
record, and acceptance requires that passing record to match the current hash,
validator version, and check-name set with `validated_at` no older than the
file mtime. Acceptance binds to `computeAuthoredContentHash(decision)`; gate
pass binds to `computeGateContentHash(gate)`.

### Adapter matrix (`adapter-matrix.md`)

Pinned pair `(figcraft-cli 0.14.0, app n/a-headless)`. `requirePinnedPair`
runs `<exe> --version` + `commands` before **every** `info`/`export` spawn,
caches the successful pair per process keyed by resolved executable path, and
fails closed with `E_UNSUPPORTED_PAIR` on any other pair (no write). `info`
gets read roots only; `export` gets read+write roots. `adapter check
[--canary <file>]` reports `canaryOk:false` unless a canary `info --json`
actually ran and parsed; the canary argv carries read roots only and its
stdout hash is recorded. Every adapter run journals `cliVersion`,
`appVersion`, `commandsHash`, `mode=headless`, roots, literal argv, exit
code, and truncated stderr. `--no-system-fonts` is passed on every call.

## Data Model

### Project layout (`.tasteful/`)

```text
.tasteful/
  project.json              # { schema_version, name, created_at, tasteful_version }
  brief.md                  # ingested brief
  coverage.json             # coverage matrix
  decisions/
    D001.json ...           # one file per decision id
    index.json              # REBUILDABLE cache; never authoritative
  gates/
    G-*.json
  events/
    E-*.json                # change events, append-only
  approvals/
    <digest32>.json         # digest, tool, target, hashes, approver, used, decision
  journal/
    run.jsonl               # hash-chained append-only journal
  validations/
    D001-<basename>-<sha8>.json  # passing/failed artifact check records
  exports/                  # exports root (created by init)
  .lock/                    # lockdir-based project lock
```

`initProject` rejects a symlinked `.tasteful` or symlinked state/export
roots (`E_PATH_SYMLINK`), and `assertStateRoots` re-checks the same roots
(`lstat` + `realpath` inside the project) on every locked operation and
every `resolveProjectPath` call, so a root swapped after init fails
(`E_PATH_SYMLINK`/`E_PATH_ESCAPE`). Lock acquisition reaps a stale lock only
when its pid is dead.

### Agent layout (`~/.tasteful/agent/`)

`settings.json` (only if an operator chooses file settings; the product uses
in-memory settings), `sessions/` (only for opt-in file-backed sessions),
`auth.json` + `models.json` (ModelRuntime, mode 0600). Tests override the
home with `TASTEFUL_HOME`; `~/.pi` is never used. The whole `agentDir()` tree
is excluded from model fs/artifact/adapter paths (`E_PATH_ESCAPE`), including
when the project root is `HOME` or `TASTEFUL_HOME` equals the project.

## Identity

Product name `tasteful`; version read from `package.json`. No pi/pi.dev/
earendil string appears in `--help`, `--version`, the system prompt, or
user-visible output. `enableInstallTelemetry: false` removes pi attribution
from the SDK's client identity, and the product extension's
`before_provider_headers` handler replaces any `User-Agent` with
`tasteful/<version>` and sets pi attribution header names to `null` (delete
marker). Tests: `tests/hermetic/identity.test.ts` (user-visible strings) and
`tests/unit/contracts.test.ts` (telemetry off in the assembled session); the
header transformation is tested offline. No real provider request is made in
the MVP.

## Security

The normative security contract is `docs/security.md`; the summary is:

1.  **Tool removal.** Explicit 12-tool allowlist; no built-ins/MCP;
    `getActiveToolNames()` asserted.
2.  **Loader containment.** Custom zero-discovery `ProductResourceLoader`:
    one inline extension, empty skills/prompts/themes/agents files, product
    system prompt; no `.pi`/`.agents`/`AGENTS.md`/`CLAUDE.md` open or stat
    (asserted under `strace`), plus poison tests for extension execution and
    loader output.
3.  **fs confinement.** realpath + roots, state-root revalidation on every
    operation (`E_PATH_SYMLINK`/`E_PATH_ESCAPE`), hardlink rejection on read
    and write, agent-state exclusion (`~/.tasteful/agent` is never readable
    when the project is home), `/proc|/sys|/dev` and `~/.pi` blocks, size
    limits, reserved-state denial, TOCTOU re-check.
4.  **Approvals.** Digest-bound, single-use, basename-only ids, deny by
    default, consumed under lock; acceptance binds the authored decision
    content hash and gate pass binds the gate content hash.
5.  **Journal.** Hash-chained, host-written; read tool verifies; status
    reports failure.
6.  **Adapter.** Fixed argv, no shell, roots, pinned-pair check before spawn,
    no retries on writes.
7.  **Environment.** `bin.ts` scrubs `PI_*`, `AI_AGENT`, and non-product
    control ports before any SDK import (so `PI_PACKAGE_DIR` cannot alter
    identity or discovery; it is ignored with a diagnostic), and child
    processes get the same prefix scrub.
8.  **Residual risk.** Honest-but-fallible model, not a hostile one; local
    approval forgery; no wire-level provider test; OS sandboxing post-MVP.

## Workflow

CLI-first, agent-optional. Every step below works deterministically without
an LLM. `tasteful run` is a **deterministic agent-wiring smoke** (real
session, mock model, fixed scripted `run_journal_read` call); the prompt is
passed through but does not drive reasoning. Real-model wiring is future
operator work.

Commands (exit codes 0 ok; 2 usage; 3 validation; 4 confinement; 5 version;
6 lock busy):

*   `tasteful init [--name <n>]` — create `.tasteful/` layout.
*   `tasteful brief --file <md> --coverage <json>` — ingest + validate.
*   `tasteful decision create --file <json> [--approval <digest|basename>]`
    — upsert; `accepted` needs the content-bound approval, a passing
    gate with its own consumed approval, and validated evidence/artifacts.
    Submitting `accepted` with a fresh approval is also the re-review
    transition that clears `stale`/`needs_review`/`invalidated`.
*   `tasteful decision get --id <D>` / `decision list`.
*   `tasteful invalidate --claim <C> --old <a> --new <b> --reason <r>
    --author <a>` — apply a change event; print the closure.
*   `tasteful gate accept (--id <G> | --file <json>) --approver <email>`
    — record a content-bound human gate approval (prints its digest).
*   `tasteful gate create --file <json> [--approval <digest>]` /
    `gate get --id <G>` — `--approval` is required for `decision: "pass"`.
*   `tasteful gate revoke --id <G> --approver <email>` — human-only revoke;
    demotes accepted decisions citing the gate (`E_GATE_BLOCKED` thereafter).
*   `tasteful validate --decision <D> --artifact <path>` — hash check, then
    execute the recorded checks and write
    `.tasteful/validations/<decision>-<basename>-<sha8>.json`; prints
    `OK …`, `DRIFT …` (hash mismatch, no record), or `CHECKS-FAILED …`
    (checks failed/inapplicable; demotes the owner and dependents). Run this
    **before** `accept` so acceptance sees a fresh passing record.
*   `tasteful adapter check [--canary <file>]` — pinned pair (+ canary).
*   `tasteful export --file <fig> --out <path> [--node <n>] [--format <f>]`
    — confined export, hashed, journaled.
*   `tasteful info --file <fig>` — read-only `info --json`.
*   `tasteful approve --list` — granted, unused records.
*   `tasteful approve --grant|--deny --tool <t> --target <tgt>
    (--content <text>|--content-file <f>) [--params-json <json>]
    [--approver <email>]` — record an approval (prints the digest).
*   `tasteful accept (--decision <D> | --file <json>) --approver <email>`
    — record a human acceptance approval bound to the submitted decision's
    authored content (prints its digest). `--decision` binds the current
    stored record; `--file` binds the exact final JSON. `accept` does not
    evaluate gates/artifacts; `decision create --approval` does, so the
    canonical order is: finalize the accepted-shape file → `validate` every
    artifact (fresh passing record) → `accept --file` →
    `decision create --file <same file> --approval <digest>`. Because
    `validate` refreshes the stored artifact's `validated_at`/`checks`, use
    the refreshed stored record (minus derived `review_state`/`decision_hash`)
    as the authored file for acceptance.
*   `tasteful fs read --file <path>` / `fs write --file <path>
    (--content <text>|--content-file <f>) [--approver <email>]` — operator
    helpers over the same fs tool.
*   `tasteful run --prompt <text> [--model mock]` — wiring smoke.
*   `tasteful status [--json]` — decisions + review states, gates, artifacts,
    journal verification. A missing gates directory is `gates: []`;
    unreadable gate files are reported as `gate_errors: [{file, error}]`
    (only when non-empty; text output prints the count) while readable gates
    remain listed. Journal failure is `journal_ok:false`,
    `journal_seq:-1`, `journal_error`; status still exits 0 (diagnostic
    honesty, not fail-closed mutation).
*   `tasteful hash --file <path>` — sha256 helper.

## Tests

Actual suite (node:test, compiled to `dist/tests`; `npm test`). Test names
below are the real names from the files; per-run counts/results are kept in
a local verification report and are not part of the public repository.

| File | Tests | Plan mapping |
|---|---|---|
| `unit/closure.test.ts` | “scope change C-PLATFORM-MOBILE yields the exact plan closure for all 7 decisions”; “prose-only change (unknown claim) is rejected…”; “graph without the claim reference on untouched branch stays current” | H11 |
| `unit/review-state.test.ts` | “authored review_state and decision_hash are rejected with E_SCHEMA”; “new decisions start current; a normal update preserves invalidation”; “stored decision tampering and filename/id mismatch are rejected on read”; “review_state is not accepted on any authored decision” | M1 / acceptance criterion 5 |
| `unit/drift.test.ts` | “drift demotes accepted owner, flags every transitive dependent, clears ready”; “matching hash leaves accepted/current/ready untouched” | H12 |
| `unit/artifact-checks.test.ts` | “artifact checks: unknown and inapplicable names fail; opens passes a plain file”; “artifact checks: a real .figcraft fixture passes opens/exports/tokens-resolve and cleans temp output”; “artifact_validate runs recorded checks, writes a record, and demotes on failure”; “acceptance matrix: failed check label 'fail' is rejected as unsupported”; “acceptance matrix: prefixed label 'opens:failed' is rejected as unsupported”; “acceptance matrix: empty checks is rejected for lacking validation checks”; “acceptance matrix: stale validated_at is rejected as stale with a validate hint”; “acceptance matrix: missing passing validation record is rejected by record name”; “acceptance matrix: unsupported validator_version 2 is rejected by version”; “acceptance matrix: mtime-only touch after validation is stale even with unchanged bytes/hash”; “acceptance matrix: a real fresh validate is stale once the artifact mtime moves later”; “acceptance matrix: ready:false is rejected before any file work”; “acceptance matrix: fresh validate -> accept -> create succeeds; artifact touched after validation is stale” | accepted-artifact check order + branch-specific messages, freshness, reviewer-A5/B2 |
| `unit/status.test.ts` | “status reports a verified journal”; “status reports corrupt journal as not ok without throwing”; “run_journal_read verifies the chain and refuses corruption”; “status treats a never-written journal on a fresh project as empty”; “status refuses a missing journal once the project holds state”; “status keeps readable gates and reports per-gate errors without failing”; “status treats a missing gates directory as no gates, not an error”; “status reports an unreadable gate file as a gate error” | journal integrity, fresh vs stateful empty journal, gate_errors honesty |
| `unit/event-id.test.ts` | “event id skips a suffix gap and never overwrites an existing event”; “writeEvent refuses to overwrite an existing event (E_EVENT_EXISTS)” | gap-safe max-suffix+1 ids, no overwrite |
| `unit/journal-cap.test.ts` | “journal beyond 1,000 entries: no clamp, strict sequence, honest status”; “duplicate seq is corruption: verify, status, and model read all refuse”; “symlinked journal leaf is refused and the target is never written”; “journal path that is a directory is refused, not treated as empty”; “zero-byte journal with a decision is corruption; no seq-1 restart”; “zero-byte journal with a gate is corruption; no seq-1 restart”; “zero-byte journal with a change event is corruption; no seq-1 restart”; “whitespace-only journal with state is corruption”; “an empty project starts a journal at seq 1 (missing, zero-byte, or whitespace-only)”; “non-entry JSON lines are rejected, not silently dropped”; “a later valid line does not mask an earlier invalid line”; “blank lines are skipped and unknown extra fields are allowed”; “preflight fresh-start flag allows the first entry after the first state write” | journal shape/chain/empty-state rules |
| `unit/gates.test.ts` | “valid gate passes”; “self-approval is rejected”; “missing evidence blocks”; “failed checklist item blocks”; “waived without waiver blocks; with waiver passes”; “waiver without expiry is schema-rejected”; “non-pass decision blocks”; “model gate_upsert cannot pass; pending/fail allowed”; “human gate create validates before write: rejected gate leaves no file”; “revoked gate is schema-valid but never passable”; “gate create cannot author revoked; the human revoke transition is separate”; “authored approval_digest is system-derived and rejected”; “model cannot overwrite a stored human pass gate (pending or fail)”; “self-approval check uses canonical identity; local-part case is a different identity”; “gate create rejects authored identity whitespace before writing”; “human gate create cannot downgrade a stored pass; gate and dependents untouched”; “human pass -> changed pass requires and restamps a fresh gate approval” | G1, model-gate boundary, stored-pass immutability matrix |
| `unit/gate-revoke.test.ts` | “human revoke flips the gate, demotes accepted dependents, and journals the transition”; “only a stored pass gate can be revoked” | revoke-only demotion, provenance |
| `unit/identity-canonical.test.ts` | “canonicalIdentity: NFKC + trim; emails lowercase the domain only”; “canonicalIdentity: empty or blank identity rejected (E_SCHEMA)”; “sameIdentity: domain/display case-insensitive, local part case-sensitive”; “authored owner/approver whitespace and blank identities are schema-rejected, never rewritten”; “decision accept grant: whitespace/domain-case/unicode variants cannot self-approve”; “decision accept grant: local-part case difference is a different identity (allowed)”; “decision accept grant: empty/whitespace-only approver rejected”; “decision accept grant: normal non-owner approver is stored canonically”; “gate accept grant: same canonical self-approval matrix”; “CLI accept normalizes --approver before granting and journaling”; “CLI approve --grant normalizes --approver before granting” | identity normalization + self-approval matrix |
| `unit/journal-preflight.test.ts` | “fsWrite preflights before approval consumption and the write”; “decisionUpsert preflights before approval consumption and the record write”; “gateUpsert preflights before approval consumption and the gate write”; “decisionInvalidate preflights before writing the event”; “artifactValidate preflights before writing a validation record or decision”; “cmdBrief preflights before writing brief.md and coverage.json” | journal preflight ordering: roots → verify → approval → mutate → append |
| `unit/approvals.test.ts` | “deny by default: no record -> E_APPROVAL_DENIED”; “grant -> consume ok; replay rejected”; “mutated payload rejected”; “denied record rejected”; “digest is stable and content-sensitive”; “acceptance grant -> use -> replay denied”; “acceptance approval by basename works once”; “acceptance approval transferred to another decision denied”; “acceptance approval for wrong owner denied”; “acceptance approval with mutated approver denied”; “acceptance approval with mutated record digest denied”; “acceptance approval id outside approvals dir denied”; “headless accepted decision without approval is denied”; “self-approval grant rejected”; “decision_get traversal and hash tamper rejected” | H13, M4, M11 |
| `unit/handshake.test.ts` | “unsupported fake CLI fails info before spawning info”; “…export before any output write”; “adapter check fails E_UNSUPPORTED_PAIR before the canary runs”; “canary not run reports canaryOk:false”; “canary runs info with read roots and hashes its output”; “pinned pair is cached per process and keyed by executable”; “reset clears the cached pair” | H19 |
| `unit/argv.test.ts` | “info argv is exact”; “export argv is exact with node+format”; “non-allowlisted op rejected pre-exec”; “canary info argv carries read roots only”; “no shell metacharacters in argv” | H10, H18, H20 |
| `unit/paths.test.ts` | “in-roots read works”; “absolute path outside roots rejected”; “.. escape rejected”; “symlink escaping roots rejected”; “symlink inside roots allowed”; “/proc/self/fd rejected”; “~/.pi rejected even if HOME set”; “hardlinked read target rejected”; “symlinked .tasteful root rejected at init”; “symlinked state subdir rejected at init”; “reserved project state writes denied even with approval”; “decision_get and gate_get reject traversal ids”; “tampered decision hash rejected on read” | H6, H10, M4, M5, M11 |
| `unit/store.test.ts` | “rebuild twice -> byte-identical index”; “upsert with missing dep rejected”; “upsert creating a cycle rejected”; “accepted without evidence/gate/approval rejected” | store invariants |
| `unit/atomic-lock.test.ts` | “atomic write leaves old content intact on crash simulation”; “two writers serialize, no lost update”; “stale lock (dead pid) is recovered” | H15 |
| `unit/hashes.test.ts` | “canonical JSON is stable under key reorder”; “sha256 of known vector”; “decision_hash excludes review_state and decision_hash”; “decision_hash changes when authored content changes”; “unknown fields are rejected”; “self-edge is rejected” | hash + schema contract |
| `unit/cycles.test.ts` | “self-edge is rejected”; “direct 2-cycle is found”; “indirect cycle is found”; “acyclic graph has no cycle” | cycle rejection |
| `unit/contracts.test.ts` | “all five JSON contracts parse with title, version, and owner”; “product and pi versions match their package.json sources”; “tool-manifest names equal PRODUCT_TOOL_NAMES”; “session assembly: exact documented options, 12 tools, telemetry off”; “decision contract: good record validates, bad records are rejected by both validators”; “change-event contract: good record validates, bad records are rejected by both validators”; “gate contract: good record validates, bad records are rejected by both validators”; “coverage contract: good record validates, bad records are rejected by both validators”; “journal contract: an emitted entry validates; malformed entries are rejected”; “adapter matrix argv equals buildInfoArgv/buildExportArgv token-for-token”; “product loader is inline-only and never consumes ambient .pi/.agents state”; “--help lists every implemented command, including info/fs/hash” | H3 (settings), H9, contract freeze, M0 evidence (loader identity) |
| `unit/state-roots.test.ts` | “symlinked exports after init fails writes and touches nothing outside”; “exports symlinked to another state root inside the project is still rejected”; “symlinked decisions after init fails decision writes and touches nothing outside”; “symlinked .tasteful after init fails lock, init, and status safely”; “state root that is a regular file is rejected” | H6/H10 state-root revalidation |
| `unit/accept-content.test.ts` | “exact accepted content is accepted; every authored mutation is E_APPROVAL_MISMATCH”; “full upsert: title, artifact-path, gate_ref, and status mutations are E_APPROVAL_MISMATCH”; “accepted rejects missing/fabricated/unsupported artifacts”; “accepted rejects missing/mismatched project evidence; external ref allowed with journal warning”; “CLI create maps mutated approved content to E_APPROVAL_MISMATCH with exit 3”; “gate pass requires an approval bound to the exact gate content”; “gate self-approval is rejected at grant time” | content-bound acceptance, gate approval |
| `unit/rereview.test.ts` | “invalidated accepted decision re-reviews to current with a fresh content approval”; “re-review without approval is rejected and artifact_validate OK does not clear state”; “stale accepted decision re-reviews to current through CLI accept --file + decision create”; “needs_review accepted decision re-reviews to current after drift is repaired”; “re-review refuses when the artifact drifted after approval”; “failed invalidation leaves no event file and no consumed event id” | re-review transition, failed-invalidate no state |
| `unit/paths.test.ts` | “in-roots read works”; “absolute path outside roots rejected”; “.. escape rejected”; “symlink escaping roots rejected”; “symlink inside roots allowed”; “/proc/self/fd rejected”; “~/.pi rejected even if HOME set”; “hardlinked read target rejected”; “hardlinked write target rejected”; “truncated read returns the full-file sha256”; “fs_read rejects files above the full-hash cap”; “agent state in a home project is denied to fs tools”; “TASTEFUL_HOME equal to the project root still hides agent state”; “symlinked .tasteful root rejected at init”; “symlinked state subdir rejected at init”; “reserved project state writes denied even with approval”; “decision_get and gate_get reject traversal ids”; “tampered decision hash rejected on read” | H6, H10, M4, M5, M11 |
| `hermetic/poison.test.ts` | “poisoned context files never enter loader output”; “real session over poisoned project: no extension, no settings, 12 tools, clean system prompt”; “CLI runs with poisoned env + home; state lands under ~/.tasteful only”; “spawned CLI with poisoned env: init/status succeed, marker never leaks”; “env scrub rule is prefix-based: all PI_*, AI_AGENT, foreign control ports”; “our src never imports pi discovery helpers” | H1, H2, H4, H16 |
| `hermetic/identity.test.ts` | “--version is product-only”; “--help is product-only”; “system prompt is product-only”; “product User-Agent is product-branded”; “session settings disable install telemetry, so getClientIdentity has no pi attribution”; “product identity headers replace pi UA and delete pi attribution”; “product loader registers the before_provider_headers handler” | H3 (offline), H17 |
| `hermetic/loader-strace.test.ts` | “status and session paths never open/stat .pi, .agents, or PI_PACKAGE_DIR state” — runs the compiled bin under `strace` for `status` and `run --model mock` in a poisoned project/home; skips with an explicit reason when `strace` is unavailable | M0 syscall evidence (zero discovery) |
| `hermetic/launcher.test.ts` | “package bin resolves to the env-first launcher”; “PI_PACKAGE_DIR is scrubbed before import: version works, diagnostic printed, no .evil discovery”; “launcher without PI_PACKAGE_DIR prints no diagnostic”; “importing cli.js has no side effects; the launcher drives it” | H2, import-order env hole |
| `integration/figcraft.test.ts` | “BRIM info is read-only and has expected shape” (skips with reason without BRIM); “tiny fixture generates deterministically (<20 nodes)”; “tiny fixture exports to temp dir” | H18 |
| `integration/approve-cli.test.ts` | “approve --grant/--deny CLI round-trip with agent fs_write” | H13 at the CLI boundary |
| `e2e/scenario.test.ts` | “BRIM end-to-end scenario through the CLI” — every step spawns `node dist/src/bin.js`; asserts exit codes, exact closure, gate-accept/decision-accept approval order, drift transition, replay denial, journal health, BRIM hash | V1 |

**Branch-removal confirmation.** The acceptance matrix was re-run against a
scratch build with each guard disabled in turn: the store vocabulary check
(covering both unsupported-label variants), store empty-checks, tools
freshness (covering stale `validated_at` and both mtime-touch variants),
tools missing-record, store validator-version, and store `ready:false` all
turn the corresponding test(s) red with a different code or message. The
matrix therefore depends on the branches it names, not on a vacuous default
(`ready:false`/stale-file baseline).

**Explicitly uncovered / deferred:**

*   H7 TOCTOU: the digest-mutation test covers approval payload mutation, not
    a live target swap between grant and write.
*   H8 MCP poisoning: no MCP is configured in the MVP (surface absent).
*   H14 kill-mid-export and H21 PhotoCraft bridge: deferred with reason.
*   Real-model wire-level provider headers: the header transformation and
    telemetry-off setting are tested offline; no network request is sent.
*   OS-level hostile-model sandboxing: residual risk, not tested.

## Rollout

*   `npm install` inside the project only; no global installs. Node ≥ 20.
*   `npm run build` (tsc strict), `npm test` (node:test runner, no network),
    `npm run e2e` (shell scenario; skips explicitly without BRIM).
*   Install/uninstall leave `~/.pi` and any `pi` install untouched; removal
    is deleting the project dir + `~/.tasteful` (documented, operator-owned).
*   pi 1.5.2 pinned exact in `package.json`; `tests/unit/contracts.test.ts`
    asserts the installed version and the documented `createAgentSession`
    option subset (`cwd`, `agentDir`, the in-memory settings instance with
    telemetry off, the 12-tool allowlist, `ProductResourceLoader`,
    `sessionManager` kind, the runtime auth path, the model id, the custom-tool
    names, and `thinkingLevel`); the zero-discovery
    guarantee is asserted by `tests/hermetic/loader-strace.test.ts` under
    `strace` (skipped explicitly when `strace` is unavailable).

## Alternatives Considered

1.  **A — fork/rebrand pi.** Rejected as primary: pi 1.5.2 identity/config
    residue (`PI_*`, pi.dev, `.pi`, `.agents`, `AGENTS.md`, logo, update
    channel) is spread across many modules; a one-week thin rebrand is
    unrealistic (4–6 weeks patch + rebase CI). Fallback if M0 hermetic exit
    criteria fail.
2.  **C — clean core (`pi-agent-core` + own auth/sessions/MCP/UI).**
    Rejected as primary: cleanest separation but 6–8+ weeks before first
    ArtCraft value. Fallback if the SDK forces implicit discovery that cannot
    be overridden.
3.  **MCP-first FigCraft transport.** Rejected for MVP: adds server lifecycle
    and exposes generic tools (`run_command`, `batch`) the plan blocks. CLI
    fixed-argv is observable and testable; MCP stays optional behind the
    same `ArtcraftAdapter` interface.
4.  **GraphRAG/embeddings for decisions.** Rejected for MVP: corpus is tens of
    authored decisions; typed claims + edge traversal are deterministic and
    reviewable.
5.  **Prose-diff invalidation (“revert when assumptions change”).** Rejected:
    non-deterministic. Change events reference `claim_id`, never sentences.
6.  **Monorepo split now.** Rejected: one package until contracts freeze.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| pi 1.5.2 API differs from plan/docs | Exact pin + version assert; ADR records imports/deviations |
| Hidden `.pi`/extension discovery | Custom zero-discovery `ProductResourceLoader` + inline-only extension + poison and `strace` tests |
| Provider carries pi identity | `enableInstallTelemetry:false` + `before_provider_headers` UA/attribution override; offline test; wire-level residual documented |
| Import-time `PI_PACKAGE_DIR` alters identity/discovery | `bin.ts` scrubs before the SDK import, prints an ignoring diagnostic, and a spawned launcher test asserts version + no `.evil` discovery |
| FigCraft CLI/app drift | Pinned pair, `requirePinnedPair` before every spawn, `commandsHash` journaled |
| Hostile-model escape via fs | realpath/roots, per-operation state-root revalidation, agent-state exclusion, hardlink read/write rejection, reserved + TOCTOU; documented residual |
| Stale lock after crash | Lockdir with pid + stale reap; tested |
| Approval replay/transfer | Digest-bound single-use consume, basename resolution, content-bound decision and gate approvals; tested + e2e |
| Fabricated accepted evidence/artifact | Acceptance checks `ready:false`, dates, empty/unknown checks, validator version, resolution/hash, mtime freshness, and a matching all-pass validation record in branch order; checks are executed by `artifact_validate`; stale/mtime-touched/missing-record → reject |
| Journal tamper or dropped history | Hash chain and line shape verified on read/status; every state-changing path preflights before approval consumption/mutation; empty/missing journal on non-empty state → `E_JOURNAL_CORRUPT`; `journal_ok:false` surfaced |
| Gate downgrade after human pass | Stored pass is immutable to model and human authored upserts; only `gate revoke` demotes (canonical approver != owner, dependents first); pass→pass changes need a fresh content-bound approval |
| Identity spoofing via case/whitespace/Unicode | Canonical NFKC+trim comparison; email domain case-folded with local-part case preserved; display ids whole-lowercase; authored padding rejected (`E_SCHEMA`); sameIdentity at grant/consume/revoke |
| Scope creep to 4 apps | FigCraft-only MVP enforced by `docs/scope.md` + adapter allowlist |

## File Boundary (shipped tree)

Create/modify (all paths relative to `tasteful/`):

*   `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `NOTICE`
*   `concepts_brief.md`, `README.md`
*   `docs/designs/tasteful-agent.md`, `docs/adr/0001-runtime.md`
*   `docs/contracts/decision-schema.json`,
    `change-event-schema.json`, `gate-schema.json`,
    `coverage-matrix-schema.json`, `run-journal-schema.json`,
    `adapter-matrix.md`, `tool-manifest.md`
*   `docs/security.md`, `docs/operator.md`, `docs/scope.md`
*   `src/bin.ts`, `src/cli.ts`, `src/version.ts`, `src/cli/identity.ts`,
    `src/cli/commands.ts`
*   `src/host/paths.ts`, `env.ts`, `session.ts`, `product-loader.ts`,
    `resources.ts`, `registration.ts`, `models.ts`, `tools.ts`,
    `approvals.ts`, `journal.ts`
*   `src/design/schema.ts`, `store.ts`, `invalidate.ts`, `gates.ts`,
    `identity.ts`, `hashes.ts`
*   `src/artcraft/figcraft.ts`, `matrix.ts`, `validate.ts`
*   `src/workflow/coverage.ts`, `run.ts`
*   `tests/helpers.ts`, `assert-code.ts`, `fixtures/decisions.ts`,
    `fixtures/generate.ts`, `unit/*.test.ts` (including `state-roots.test.ts`,
    `accept-content.test.ts`, `rereview.test.ts`, `artifact-checks.test.ts`,
    `drift.test.ts`, `gate-revoke.test.ts`, `identity-canonical.test.ts`,
    `journal-preflight.test.ts`, `journal-cap.test.ts`, `event-id.test.ts`),
    `hermetic/*.test.ts` (including `loader-strace.test.ts`,
    `launcher.test.ts`), `integration/*.test.ts`, `e2e/scenario.test.ts`
*   `scripts/e2e.sh`

Read-only inputs: an optional FigCraft fixture supplied via `TASTEFUL_BRIM`;
nothing writes to it. `~/.pi/` is never used behaviorally. Nothing under
`node_modules` is edited.

### Test Plan (acceptance)

*   `npm run build` exits 0, strict `tsc`, no diagnostics.
*   `npm test` exits 0: unit + hermetic + integration + e2e; fixture-dependent
    tests skip with an explicit reason when `TASTEFUL_BRIM` is unset or the
    fixture is absent.
*   `npm run e2e` exits 0 and leaves the fixture byte-identical; asserts exit
    codes and JSON at every step.
*   Manual CLI checks in temp HOME: `--version`/`--help` product-only;
    `init` creates `.tasteful/`; `status --json` matches e2e asserts.
*   No `TODO`, placeholder, fake fallback, or unimplemented documented
    command in shipped code.
