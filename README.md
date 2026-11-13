# Tasteful

Hermetic product-design agent on the pi 1.5.2 SDK engine (FigCraft MVP).

Tasteful keeps an explicit, typed decision graph next to the design work —
claims, `depends_on` edges, change events, gates, artifact hashes — and
drives FigCraft `info`/`export` through a confined fixed-argv adapter. The
pi SDK provides only the agent loop, tool execution, model runtime, and
session primitives; Tasteful owns its package, binary, paths, sessions,
settings, tools, approvals, identity, and update channel.

Core invariants: owner/approver identity is canonical (NFKC + trim; email
domains lowercased with local-part case preserved; other ids whole-lowercase;
authored whitespace rejected); a stored pass gate is immutable except through
`gate revoke`; accepted artifacts require actually executed checks plus a
hash/version/name-set/freshness-matched passing validation record; and every
state-changing path preflights the hash-chained journal before consuming an
approval or mutating state.

## Layout

*   `src/bin.ts` — env-first launcher: scrubs `PI_*`/`AI_AGENT` control
    state before importing the SDK; `tasteful`/`dist/src/bin.js` is the entry
    point
*   `src/cli.ts`, `src/cli/` — CLI dispatch (library), commands, product identity
*   `src/version.ts` — product version from `package.json` + installed pi
    version assert against the exact pin
*   `src/host/` — paths, env scrub, session assembly, zero-discovery product
    resource loader, mock model runtime, tool definitions (`registration.ts`),
    approvals, journal
*   `src/design/` — schema, store (atomic writes, lock, index, hash verify),
    identity canonicalization, closure, gates, hashes
*   `src/artcraft/` — FigCraft adapter + pinned-pair handshake matrix
*   `src/workflow/` — coverage matrix, deterministic run smoke
*   `tests/` — unit, hermetic (poison, loader strace, launcher), integration,
    e2e, fixtures
*   `docs/` — design, ADR, contracts, security, operator, scope

## Build / test

```sh
npm install
npm run build
npm test
npm run e2e
```

`TASTEFUL_HOME` overrides the home used for agent state. `figcraft-cli
0.14.0` must be on `PATH`. Set `TASTEFUL_BRIM` to a read-only FigCraft
fixture for the optional end-to-end scenario. When it is unset, the
fixture-dependent tests skip with an explicit reason, so a clean checkout does
not fail. `npm run e2e` exits 0 with `E2E-CLI SKIP` when the fixture is
missing.

Run the product with `node dist/src/bin.js …` (or the linked `tasteful`
bin). `dist/src/cli.js` is a library module and prints nothing when executed
directly. A set `PI_PACKAGE_DIR` is ignored with the diagnostic
`TASTEFUL: ignoring PI_PACKAGE_DIR=<value>` before the SDK loads.

`tasteful run --prompt ... --model mock` is a deterministic agent-wiring
smoke: it assembles the real session but scripts a fixed
`run_journal_read` tool call; it does not reason from the prompt. Real
model wiring is not part of the MVP CLI.

In-memory session persistence is the default for test/deterministic runs;
`assembleSession({ inMemorySession: false })` opts into file-backed
sessions under `~/.tasteful/agent/sessions`.

## Docs

*   `concepts_brief.md` — EGM concept brief
*   `docs/designs/tasteful-agent.md` — self-contained design + implementation plan
*   `docs/adr/0001-runtime.md` — runtime decision, exact imports, deviations
*   `docs/contracts/` — schemas, adapter matrix, tool manifest
*   `docs/security.md`, `docs/operator.md`, `docs/scope.md`

Verification evidence is kept locally and is not part of the public
repository.

## License

MIT. See `LICENSE` and `NOTICE`.
