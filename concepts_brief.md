# Tasteful — Concepts Brief

Date: 2026-11-11. Method: EGM (elephant draft, goldfish review follows).
Source requirements: the approved internal build plan (not included in the
public repository), with conditional agreement from two adversarial reviewers
on the B-hermetic option.

## Problem

Product design work (brief, evidence, screens, gates) loses traceability:
decisions live in prose, rationale is scattered, a scope change silently
invalidates earlier choices, and design files evolve without a hash-linked
record of what was approved. Tasteful is a product-design agent that keeps an
explicit, typed decision graph next to the design work and drives FigCraft
operations (inspect, export) through a confined adapter.

## Core hypothesis

A small authored graph — typed claims, one authored edge (`depends_on`), change
events, gates, artifact hashes — gives deterministic invalidation and
evidence-linked acceptance, without embeddings or GraphRAG. Lexical/metadata
lookup plus edge traversal is enough for the MVP corpus (tens of decisions,
not thousands of documents).

## What Tasteful is

- A Node.js + TypeScript package (`tasteful-agent`), binary `tasteful`.
- A hermetic host on the pi 1.5.2 SDK engine: explicit `cwd`, `agentDir`,
  `settingsManager`, `sessionManager`, `modelRuntime`, `resourceLoader`,
  `tools`, `customTools`, `model`. No pi CLI/TUI at runtime. No behavioral use
  of `.pi`, `.agents`, `AGENTS.md`, `CLAUDE.md`, `PI_*`, `AI_AGENT=pi`, pi.dev
  identity, or pi auto-update.
- Product tool set only (no `bash`/`write`/`edit`/`eval`/`codemode` from the
  model): `fs_list`, `fs_read`, `fs_write` (approval), `decision_get`,
  `decision_upsert`, `decision_invalidate`, `artifact_validate`,
  `artcraft_info`, `artcraft_export`, `gate_get`, `gate_upsert`,
  `run_journal_read`.
- A decision core: authored decisions, typed claims, `depends_on` as the only
  authored edge, derived review state, change events, transitive invalidation,
  artifact hashes, gates, atomic writes, project lock, cycle rejection.
  `accepted` requires owner, hashed evidence, validated artifact, passed gate,
  and a human approval from someone other than the owner.
- A FigCraft adapter: fixed executable + argv, no shell, no generic
  `run_command`/`batch` tools, `--automation-read-root`/`--automation-write-root`
  confinement, `info` + `export` first. An optional FigCraft fixture supplied
  via `TASTEFUL_BRIM` is read-only input for the end-to-end scenario.
- A run journal (versions, hashes, roots, steps, errors) that the model cannot
  write, and an approval store (operation digest, single-use, deny-by-default
  headless).

## What Tasteful is not (MVP)

FigCraft only. VectorCraft/PhotoCraft/EffectCraft, GraphRAG/embeddings,
telemetry, auto-update, multi-user, GUI attach, and migration from `~/.pi`
are out. MCP is optional behind the same adapter interface, not required.

## Key trade-offs accepted

1. **B-hermetic host instead of fork/rebrand (A) or clean core (C).** A thin
   rebrand cannot remove pi residue (`PI_*`, pi.dev, `.pi`, update) in
   reasonable time; a clean core rebuilds auth/sessions/MCP/UI before any
   ArtCraft value. B-hermetic owns all paths and services and is falsifiable
   by strace/import/env tests (exit criteria M0).
2. **One package first.** Split into `design-core`/`artcraft`/`eval` packages
   only after contracts freeze (post M2). Fewer moving parts for the MVP.
3. **CLI adapter first, MCP optional.** The fixed-argv CLI path is observable
   (exact command construction tests) and needs no server lifecycle. MCP would
   add `run_command`-style generic-tool risk the plan explicitly blocks.
4. **Deterministic workflow without an LLM for tests; real pi session with a
   mock model for the agent path.** The mock goes through `createAgentSession`
   and the product tools, not around them.

## End-to-end proof (must run)

Temp project + temp HOME: `tasteful init`; ingest brief + coverage matrix;
D001–D007 with claims/evidence/artifacts/edges; FigCraft `info` + frame export
to the temp exports root with hash; gate with non-owner approver (reject
self-approval, reject missing evidence); `accepted` rejected without
evidence/approval, accepted with them; scope change
`C-PLATFORM-MOBILE -> mobile-web+ios` yields exactly D001/D002 stale,
D003/D005 needs_review, D006 invalidated, D004/D007 current, no artifact ready;
artifact mutation flips its decision to needs_review; mock-model run through
the real pi session/tool pipeline; `tasteful status --json` reports the state;
`--version`/`--help` show product identity only.

## Risks carried into design

- pi 1.5.2 internal APIs (`createAgentSession` options, model interface) may
  differ from the plan; the spike (Phase 0 of implementation) pins exact
  imports and records deviations in an ADR.
- FigCraft CLI/app version drift (0.14.0 observed CLI); the adapter pins the
  verified pair fail-closed.
- `realpath` + allowlist confines an honest model, not a hostile one; OS
  sandboxing stays a documented P0 follow-up, not an MVP claim.
