# Adapter matrix (MVP: FigCraft CLI)

Owner: artcraft. Version: 1. Verified 2026-11-11 against `figcraft-cli
0.14.0`.

## Pinned pair

*   `figcraft-cli`: `0.14.0` (verified: `figcraft-cli --version`).
*   Standalone `figcraft` app binary: **not found on PATH** (`command not
    found`). The MVP pins `(cli 0.14.0, app n/a-headless)`; headless CLI mode
    only, no `--attach`.
*   Any other pair → `E_UNSUPPORTED_PAIR`; the check runs **before** any
    `info`/`export` spawn, so writes are refused (fail-closed).

## Enforcement (one path)

`requirePinnedPair(exe)` runs `<exe> --version` and `<exe> commands`,
asserts the exact pinned version, and caches `{cliVersion, appVersion,
commandsHash, exePath}` per process keyed by the resolved executable path.
Both `figcraftInfo` and `figcraftExport` call it before building/spawning
their operation argv; a mismatch throws `E_UNSUPPORTED_PAIR` with no
operation side effect. `resetAdapterHandshakeCache()` exists for tests only.
The MVP uses the CLI on `PATH`; there is no ambient app binary discovery.

## Operations allowlist (MVP)

| Op | CLI argv | Mode | Roots | Idempotent | Notes |
|---|---|---|---|---|---|
| `info` | `figcraft-cli info --json --no-system-fonts [--automation-read-root R]… <FILE>` | headless | read only | yes | read-only w.r.t. the source file; no write root |
| `export` | `figcraft-cli export --no-system-fonts [--format F] [--page P] [--node N] [--scale S] --out <OUT> [--automation-read-root R]… [--automation-write-root W]… <FILE>` | headless | read=project/source, write=exports | yes (same bytes for same input+flags) | output hashed + journaled; `tests/unit/contracts.test.ts` parses this row and asserts the exact token order |

Explicitly **not** allowlisted in the MVP: `convert`, `run`, `render`,
`plugin`, `connect`, `perf`, `mcp`. Each needs its own row here plus an
argv-construction test before use. A non-allowlisted op fails before spawn
with `E_NOT_ALLOWLISTED`.

## `tasteful adapter check [--canary <file>]`

1.  Run `<exe> --version`; parse `figcraft-cli X.Y.Z`; exact-match the pin.
2.  Run `<exe> commands`; record `sha256(stdout)` as `commandsHash` (drift
    signal, not a blocker; the version pin is the blocker).
3.  If `--canary` is supplied: run `info --json --no-system-fonts
    --automation-read-root <dirname(canary)> <canary>`, assert stdout parses
    as JSON, and record `canaryHash = sha256(stdout)`. Read-only: no write
    root is attached.
4.  Print one line: `cli=<version> app=n/a-headless commands=<16 hex>
    canary=<true|false>`, plus ` canary_hash=<64 hex>` when the canary ran.

`canaryOk` is `false` (and `canary: "not_run"`) when no canary is supplied;
it becomes `true` (`canary: "ok"`) only after a successful canary `info`
parse. There is no implicit/auto canary fixture.

## Journal

Every `info`/`export`/`adapter check` journals kind `adapter` under the
project run journal with: `cliVersion`, `appVersion`, `commandsHash`,
`mode: "headless"`, `roots` (`read`, `write`), literal `argv`, `exit_code`,
and truncated `stderr_tail` (≤ 4 KiB) when applicable. Output files are
hashed and recorded.

## Error taxonomy

`transport` (spawn failure), `command` (`E_ADAPTER_COMMAND`: nonzero exit or
malformed argv), `validation` (`E_ADAPTER_VALIDATION`: output does not
parse), `confinement` (`E_PATH_ESCAPE`/`E_NOT_ALLOWLISTED`),
`version` (`E_UNSUPPORTED_PAIR`). Reads: retry ≤ 2 with backoff, idempotent
only. Writes: 0 automatic retries; explicit resume from the journal.

## Determinism

`--no-system-fonts` is passed on every `info`/`export`/canary call so
renders match across machines (the CLI also honors
`FIGCRAFT_NO_SYSTEM_FONTS=1`). The adapter never shells out: a fixed
executable plus literal argv array; elements containing shell
metacharacters are rejected.
