# Tasteful — scope (implemented vs deferred)

## Implemented (MVP)

*   Hermetic host on pi 1.5.2 SDK: explicit cwd/agentDir/settings/session/
    model-runtime/resource-loader/tools/customTools/model; custom
    `ProductResourceLoader` with zero discovery and zero filesystem calls
    (one inline product extension; empty skills/prompts/themes/agents files),
    in-memory product settings (`enableInstallTelemetry: false`), and
    `PI_PACKAGE_DIR` scrubbed by the `bin.ts` launcher before the SDK import
    (ignored with a diagnostic).
*   Product session allowlist `tools: [...PRODUCT_TOOL_NAMES]` (exactly the
    12 product tools); no pi built-ins, `codemode`, `tool_search`, or MCP
    tools. The documented option subset (`cwd`, `agentDir`, settings flags,
    resource loader, tools, session-manager kind, runtime auth path, model id,
    custom-tool names, thinking level) is asserted in the contract test.
*   Provider identity: install telemetry off (no pi identity attribution)
    and a `before_provider_headers` handler that replaces `User-Agent` with
    `tasteful/<version>` and deletes pi attribution headers.
*   Decision core: schema v1, typed claims, `depends_on`-only authored
    edges, derived `review_state` (authored values rejected), change events
    with gap-safe per-day `max+1` ids (`E_EVENT_EXISTS` defense), normative
    closure, artifact-hash drift with dependent propagation, executed
    artifact checks (`opens`/`exports`/`tokens-resolve`), hash- and
    mtime-bound validation records with branch-specific acceptance
    rejections, gates with approval provenance and revoke-only pass
    demotion, canonical owner/approver identity (NFKC+trim; email-domain
    lowercase only; display ids whole-lowercase; authored whitespace
    rejected), atomic writes, project lock, cycle rejection, rebuildable
    `index.json`, and verified `decision_hash` on read.
*   Approvals: digest-bound, single-use, deny-by-default headless, TOCTOU
    re-check, approval ids constrained to basenames under
    `.tasteful/approvals/`. `approve --grant|--deny` is a working CLI flow;
    `decision_accept` binds the authored decision content hash and
    `gate_accept` binds the gate content hash. A passing gate stores the
    consumed `approval_digest`; acceptance requires that provenance.
    Self-approval checks use canonical identity at grant, consume, and
    revoke. Accepted decisions resolve and re-hash every artifact/evidence
    file, require a fresh passing validation record, and the accepted write
    is also the explicit re-review transition to `current`.
*   Run journal: hash-chained, host-only writes, no internal length cap
    (full-chain verification at any size), regular-file leaf check
    (`E_JOURNAL_LEAF`), per-line JSON/object/seq shape checks,
    missing-or-empty-with-state corruption, fresh-project blank/missing
    journal start, preflight verification before approval consumption or
    mutation in every state-changing path, model read-only via
    `run_journal_read`; `status --json` reports `journal_ok: false` plus the
    error instead of a hardcoded true and surfaces unreadable gates as
    `gate_errors` without failing closed.
*   FigCraft CLI adapter: `info` + `export`, fixed argv, read/write roots,
    pinned-pair handshake (`requirePinnedPair`) before every spawn,
    optional canary, and adapter journal facts.
*   Confinement: realpath + allowlist, realpath-based reserved-state denial,
    per-operation state-root revalidation (`E_PATH_SYMLINK`/`E_PATH_ESCAPE`),
    agent-state exclusion, hardlink read/write rejection, whole-file
    `fs_read.sha256`, and TOCTOU re-check.
*   CLI: init/brief/decision/invalidate/gate/validate/adapter/export/info/
    approve/accept/fs/run/status/hash with product-only identity and
    documented exit codes.
*   Tests: unit (closure, hashes, cycles, atomic, lock, gates, escapes,
    state roots, approvals, accept-content, re-review, artifact-checks
    acceptance matrix, drift, argv, handshake, contracts, store, review
    state, journal-preflight, journal-cap, identity-canonical, event-id),
    hermetic (poison, identity, loader strace, launcher), integration
    (fixture read-only info, tiny fixture), e2e (full CLI fixture scenario through
    `dist/src/bin.js` child processes).

## Deliberately deferred

*   VectorCraft / PhotoCraft / EffectCraft production support.
*   MCP transport (optional behind the same adapter interface; not required).
*   GUI attach (`--attach`), display/Xvfb harness.
*   Embeddings / GraphRAG retrieval (lexical + edge traversal is the MVP).
*   Telemetry, auto-update, sharing, multi-user auth.
*   Migration from `~/.pi` (strict separation instead).
*   Blind-rating evaluation harness (E1), skills/context matrix (S1),
    mid-export kill recovery (H14), PhotoCraft token bridge (H21).
*   Real-model wiring in the CLI: the operator chooses provider/model (see
    the user note); the MVP CLI supports `--model mock` only, and session
    assembly takes an explicit `Model` for future wiring.
*   Wire-level provider-header capture against a real model endpoint (the
    offline test asserts the header transformation, not a network request).
*   OS-level sandboxing against a hostile model (documented residual risk).

## Explicitly tolerated (narrowed guarantees, not deferred features)

*   Journal readers tolerate unknown extra entry fields for forward
    compatibility; emitted entries still match the closed v1 contract, and
    extra fields are not part of `payload_hash`. This is a deliberate reader
    leniency, not schema expansion.
*   `status` reports unreadable gate files as `gate_errors` and keeps
    readable gates instead of failing the whole command; it is a diagnostic
    and exits 0 with an honest body. State-changing paths remain fail-closed
    (journal preflight, state-root checks).
*   Email identity comparison lowercases only the domain; local-part case is
    treated as significant. Display-id comparison is whole-value
    case-insensitive. Authored identity whitespace is rejected rather than
    trimmed, preserving content hashes.
