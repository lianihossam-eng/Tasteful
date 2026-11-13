# ADR-0001: B-hermetic runtime on pi 1.5.2

Date: 2026-11-11. Status: accepted (spike verified; round-1 through round-4 fixes applied).

## Decision

Tasteful is a hermetic host on `@earendil-works/pi-coding-agent@1.5.2`
(exact pin) with `@earendil-works/pi-ai@1.5.2` and `typebox@1.3.27` as
declared direct dependencies. The product version comes from our
`package.json`; the installed pi version is read from its `package.json` and
asserted equal to the exact pin at startup (`src/version.ts`). Every
`createAgentSession` boundary is supplied explicitly:

| Option | Tasteful value |
|---|---|
| `cwd` | project root (explicit) |
| `agentDir` | `~/.tasteful/agent` (`TASTEFUL_HOME` override) |
| `settingsManager` | `SettingsManager.inMemory({ compaction: {enabled:false}, retry: {enabled:false,maxRetries:0}, enableInstallTelemetry:false })`, shared by loader and session |
| `sessionManager` | `SessionManager.inMemory(projectRoot)` by default; `SessionManager.create(projectRoot, <agentDir>/sessions)` only with `inMemorySession: false` |
| `modelRuntime` | `ModelRuntime.create({ authPath, modelsPath, allowModelNetwork:false, refreshOnCreate:false })` under `~/.tasteful` |
| `resourceLoader` | product `ProductResourceLoader` (custom, zero discovery): one synthetic inline extension `<inline:tasteful-tools>` populated through a minimal `ExtensionAPI` shim (`on` + `registerTool` only); empty skills/prompts/themes/agents files; product `systemPrompt`; `appendSystemPrompt: []`. No `DefaultResourceLoader`, no package manager, no filesystem calls. |
| `tools` | explicit allowlist `[...PRODUCT_TOOL_NAMES]` (exactly 12 product tools) |
| `customTools` | product `ToolDefinition[]` via `defineTool()` |
| `model` | explicit `Model` (faux provider mock in tests/CLI smoke) |
| `thinkingLevel` | `off` |

`createAgentSession` is exported from `./core/sdk.ts` (re-exported by the
package index). SDK sessions do not load `codemode`/`tool_search`/MCP unless
added via a resource loader extension factory; we use a product loader and
never add them.

## Exact imports (spike record, corrected during implementation)

```ts
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type Extension,
  type ExtensionAPI,
  type ExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
```

*   Product tools are `ToolDefinition`s built with `defineTool()` and passed
    as `customTools`, and additionally registered through the product inline
    extension (`src/host/product-loader.ts`) so extension-level hooks
    (`before_provider_headers`) run.
*   The session uses `tools: [...PRODUCT_TOOL_NAMES]` as an explicit
    allowlist (exactly the 12 product tools). An empty allowlist was tried
    first but disables custom tools too (`sdk.js`: `allowedToolNames` =
    `options.tools ?? ...`), leaving zero active tools; the explicit
    allowlist is the correct hermetic setting and `getActiveToolNames()` is
    asserted equal to the manifest on every session assembly
    (`tests/unit/contracts.test.ts`, and assembly itself).
*   The mock model is `fauxProvider()` from `@earendil-works/pi-ai` (shipped
    test provider): `faux.setResponses([...])` scripts assistant messages
    including `fauxToolCall(name, args)`; the provider is registered with
    `modelRuntime.registerNativeProvider(faux.provider)` and the model is
    passed explicitly. This goes through the real agent loop, real tool
    execution, and real session persistence primitives.
*   Provider identity: `enableInstallTelemetry:false` makes the SDK's
    `getClientIdentity()` carry no pi attribution. The product extension
    registers `pi.on("before_provider_headers", …)`; `applyProductIdentityHeaders`
    replaces any `User-Agent` with `tasteful/<version>` and sets pi's
    attribution header names (`http-referer`, `x-openrouter-title`,
    `x-openrouter-categories`, `x-billing-invoke-origin`,
    `x-opencode-client`) to `null` (the SDK's delete marker). Evidence:
    `tests/unit/contracts.test.ts` asserts telemetry is off; the offline
    header test asserts the transformation. No real provider request is made
    in the MVP (wire-level evidence is residual, not claimed).

## Deviations from the plan (explicit)

1.  **Metadata read of pi's `package.json` is allowed and used.** Importing
    the SDK reads its `package.json` (module metadata), and `src/version.ts`
    reads the installed version to assert the exact pin. Only *behavioral*
    use of `PACKAGE_NAME`/`APP_NAME`/`CONFIG_DIR_NAME`/`VERSION` for identity
    paths, update, or sessions is forbidden; tests assert that behavior.
2.  **`ProviderAuth` shape for the mock provider.** `fauxProvider()` ships
    its own auth (apiKey resolve reports configured); no credential files are
    created for the mock path. Real-model operation would require an
    explicit operator-provided key via `modelRuntime.setRuntimeApiKey()`;
    the CLI does not wire real models in the MVP.
3.  **Custom zero-discovery `ProductResourceLoader`.** The design originally
    called for a fully custom `ResourceLoader`; the first implementation used
    `DefaultResourceLoader` because `loadExtensionFromFactory` is not
    exported by the package index (a deep import is blocked by `exports`).
    Round-2 verification showed that `DefaultResourceLoader` still builds
    `DefaultPackageManager` and therefore stats `.pi/extensions`,
    `.agents/skills`, and even ambient `~/.agents/skills` during
    `resolve()` — `noExtensions`/`noSkills` only skip *loading*. The shipped
    loader is now a plain class implementing the exported `ResourceLoader`
    interface. It constructs one `Extension` object directly (synthetic path
    `<inline:tasteful-tools>`, Maps, `createExtensionRuntime()`), populates
    its `handlers`/`tools` by running `productToolsExtension(reg)` against a
    minimal `ExtensionAPI` shim (`on` + `registerTool`; every other method
    throws), and returns empty skills/prompts/themes/agents files plus the
    product system prompt. It contains no filesystem or discovery code.
    Evidence: `tests/hermetic/loader-strace.test.ts` traces `openat`/`statx`/
    `stat`/`lstat` for `status` and `run --model mock` in a poisoned
    project/home and asserts zero trace lines under `.pi`/`.agents`;
    `tests/unit/contracts.test.ts` asserts the loader identity and the
    inline-only output; `tests/hermetic/poison.test.ts` asserts no extension
    execution and no poison text. The strace test skips explicitly when
    `strace` is absent (the syscall claim is then not run, not silently
    assumed).
4.  **Env-first launcher (`src/bin.ts`).** `PI_PACKAGE_DIR` is read by the
    SDK's `config` module at import time, before any code in `cli.main()`
    could scrub it. The package `bin` now points at `src/bin.ts`, whose only
    static import is the Node-builtins-only env helper. It captures a set
    `PI_PACKAGE_DIR`, calls `scrubProcessEnv()`, prints
    `TASTEFUL: ignoring PI_PACKAGE_DIR=<value>` to stderr, and then
    dynamically imports `cli.js`; the value is never used for identity or
    discovery. `cli.ts` exports `main`/`runCli` and no longer self-executes.
    Evidence: `tests/hermetic/launcher.test.ts` spawns the real bin with a
    fake package (`9.9.9`, `piConfig.configDir: ".evil"`) and asserts
    `tasteful 0.1.0`, the diagnostic, and no `.evil` discovery.
5.  **Tool parameters use `typebox`** (`Type.Object(...)`); it is a declared
    direct dependency, not a transitive one.
6.  **Session persistence is in-memory by default.** The original text said
    sessions persist under `~/.tasteful/agent/sessions`; the product default
    is `SessionManager.inMemory(projectRoot)` for deterministic tests/CLI
    runs. File-backed sessions remain an explicit opt-in
    (`assembleSession({ inMemorySession: false })`).
7.  **Provider header override is an extension hook, tested offline.** The
    SDK always assembles a pi identity; the supported override is
    `before_provider_headers`. We assert the header transformation and
    telemetry setting without a network request.

## Round-4 clarifications (not runtime deviations)

These harden invariants inside the same hermetic runtime; no SDK option or
dependency changed.

*   **Identity.** Owner/approver comparison is canonical: NFKC + trim; email
    shapes lowercase the domain only (local-part case preserved), other ids
    lowercase the whole value, empty is rejected. Authored identity fields
    store verbatim and reject padding (`E_SCHEMA`); CLI `--approver` input is
    canonicalized before granting. Tables: `docs/security.md`,
    `docs/operator.md`.
*   **Journal preflight.** Every state-changing locked path verifies the
    hash-chained journal after state-root revalidation and before approval
    consumption or mutation (`fs_write`, `decision_upsert`, gate
    upsert/revoke, `decision_invalidate`, `artifact_validate`, `brief`);
    `init` creates state and is exempt. Empty/whitespace/missing journal
    rules and line-shape checks are in `docs/security.md`.
*   **Gate immutability.** A stored `pass` gate can only be demoted by
    `gate revoke`; authored human `pending`/`fail`/`revoked` over it is
    `E_GATE_HUMAN_ONLY`, and `pass`→`pass` changes need a fresh
    content-bound `gate_accept` approval.
*   **Status honesty.** `status` keeps readable decisions/gates, reports
    `gate_errors` and `journal_ok:false` honestly, and still exits 0; it is
    a diagnostic, not a state-changing command.

## Hermetic exit criteria (M0) — how each is tested

*   Zero `open/read/stat` under `~/.pi`, project `.pi`, `.agents`, or
    `~/.agents`: `tests/hermetic/loader-strace.test.ts` traces the compiled
    bin (`status`, `run --model mock`) in a poisoned project/home and asserts
    no trace line contains those paths; the poison test additionally asserts
    no extension execution and no poison text in loader/session output.
*   No `getAgentDir()`/`CONFIG_DIR_NAME` behavioral use: import-audit test
    greps our `src/` for those identifiers (must be absent) and asserts
    runtime paths.
*   No `AGENTS.md`/`CLAUDE.md` ingestion: poison files with marker text;
    assert marker absent from the loader/system prompt.
*   No `PI_*`/`AI_AGENT` influence before import: `src/bin.ts` scrubs before
    the dynamic `cli.js` import and prints a `PI_PACKAGE_DIR` ignoring
    diagnostic; launcher and child-env tests assert the prefix scrub.
*   No pi.dev attribution: `enableInstallTelemetry:false` + provider header
    override; offline assertions (wire-level residual documented).
*   Sessions/auth/settings only under `~/.tasteful`: path asserts with temp
    HOME; session persistence is in-memory unless opted in.
*   No model reach into agent state: `~/.tasteful/agent` (including when the
    project root is `HOME`) is denied by `resolveProjectPath`
    (`tests/unit/paths.test.ts`).
*   One ArtCraft `info`, one decision write, one export: CLI e2e scenario.

## Fallback

If any exit criterion fails because a required agent-loop module forces
implicit pi discovery that cannot be overridden, the decision flips to plan
fallback A (maintained fork) or C (clean core). No silent downgrade.
