/**
 * FigCraft adapter matrix: pinned pair + handshake + one journal helper.
 *
 * Every `info`/`export` spawn is gated by `requirePinnedPair()` (H19). The
 * success is cached per process keyed by the resolved executable path, so a
 * run costs one `--version` and one `commands` call regardless of how many
 * adapter operations it performs. Failures are never cached: the next call
 * re-checks and fails closed again.
 */
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { childEnv } from "../host/env.js";
import { appendJournal, type JournalActor, type JournalContext } from "../host/journal.js";
import { withLock, type ProjectPaths } from "../design/store.js";
import { sha256Hex } from "../design/hashes.js";

export const FIGCRAFT_CLI = "figcraft-cli";
export const PINNED_CLI_VERSION = "0.14.0";
export const PINNED_APP_VERSION = "n/a-headless";

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

export type AdapterOp = "info" | "export";

const ALLOWLIST: AdapterOp[] = ["info", "export"];

export function assertAllowlisted(op: string): asserts op is AdapterOp {
  if (!(ALLOWLIST as string[]).includes(op)) {
    throw new AdapterError("E_NOT_ALLOWLISTED", `adapter op '${op}' is not allowlisted`);
  }
}

function runFile(
  exe: string,
  argv: string[],
  opts: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(exe, argv, { env: childEnv(), timeout: opts.timeoutMs ?? 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number }).code;
        reject(new AdapterError("E_ADAPTER_COMMAND", `${exe} ${argv.join(" ")} failed (code ${String(code)}): ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** A verified pinned (cli, app) pair plus the commands hash to journal. */
export interface AdapterPair {
  cliVersion: string;
  appVersion: string;
  commandsHash: string;
  /** Canonical executable path used as the process-cache key. */
  exePath: string;
}

export interface Handshake extends AdapterPair {
  /** True only when a canary `info` actually ran and parsed. */
  canaryOk: boolean;
  canary: "not_run" | "ok";
  /** sha256 of the canary `info --json` output; absent when not run. */
  canaryHash?: string;
}

export interface AdapterCheckOptions {
  canary?: string;
  /** Extra read roots for the canary run (the canary's directory is always added). */
  readRoots?: string[];
}

/**
 * Resolve an executable to a stable cache key. Bare names are looked up on
 * PATH; anything found is realpathed so symlink aliases share one entry.
 */
export function resolveExePath(exe: string): string {
  const findOnPath = (name: string): string | undefined => {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch {
        // keep looking
      }
    }
    return undefined;
  };
  if (exe.includes(path.sep)) {
    try {
      return realpathSync(exe);
    } catch {
      return path.resolve(exe);
    }
  }
  return findOnPath(exe) ?? exe;
}

const pairCache = new Map<string, AdapterPair>();

/** Test seam: forget all cached handshakes. */
export function resetAdapterHandshakeCache(): void {
  pairCache.clear();
}

export async function cliVersion(exe = FIGCRAFT_CLI): Promise<string> {
  const { stdout } = await runFile(exe, ["--version"], {});
  const m = stdout.trim().match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new AdapterError("E_ADAPTER_COMMAND", `cannot parse version from: ${stdout.slice(0, 200)}`);
  return m[1];
}

/**
 * Fail-closed pinned-pair check: `--version` must be exactly
 * PINNED_CLI_VERSION and `commands` must succeed. Success is cached per
 * process keyed by the resolved executable path; any other pair throws
 * E_UNSUPPORTED_PAIR before an adapter operation spawns.
 */
export async function requirePinnedPair(exe = FIGCRAFT_CLI): Promise<AdapterPair> {
  const key = resolveExePath(exe);
  const cached = pairCache.get(key);
  if (cached) return cached;
  const version = await cliVersion(exe);
  if (version !== PINNED_CLI_VERSION) {
    throw new AdapterError(
      "E_UNSUPPORTED_PAIR",
      `figcraft-cli ${version} is not the pinned ${PINNED_CLI_VERSION} (app ${PINNED_APP_VERSION})`,
    );
  }
  const { stdout } = await runFile(exe, ["commands"], {});
  const pair: AdapterPair = {
    cliVersion: version,
    appVersion: PINNED_APP_VERSION,
    commandsHash: sha256Hex(stdout),
    exePath: key,
  };
  pairCache.set(key, pair);
  return pair;
}

/** Exact argv for the canary `info` run (read roots only, never write). */
export function buildCanaryInfoArgv(canary: string, readRoots?: string[]): string[] {
  const roots = new Set<string>();
  roots.add(path.dirname(path.resolve(canary)));
  for (const r of readRoots ?? []) roots.add(path.resolve(r));
  const argv = ["info", "--json", "--no-system-fonts"];
  for (const r of roots) argv.push("--automation-read-root", r);
  argv.push(canary);
  return argv;
}

/**
 * Fail-closed handshake. `canaryOk` is false unless a canary was supplied and
 * its `info --json` output parsed; the canary is hashed into `canaryHash`.
 */
export async function adapterCheck(
  exe = FIGCRAFT_CLI,
  canaryOrOptions?: string | AdapterCheckOptions,
): Promise<Handshake> {
  const opts: AdapterCheckOptions =
    typeof canaryOrOptions === "string" ? { canary: canaryOrOptions } : (canaryOrOptions ?? {});
  const pair = await requirePinnedPair(exe);
  const base = {
    cliVersion: pair.cliVersion,
    appVersion: pair.appVersion,
    commandsHash: pair.commandsHash,
    exePath: pair.exePath,
  };
  if (!opts.canary) {
    return { ...base, canaryOk: false, canary: "not_run" };
  }
  const argv = buildCanaryInfoArgv(opts.canary, opts.readRoots);
  const { stdout } = await runFile(exe, argv, {});
  try {
    JSON.parse(stdout);
  } catch {
    throw new AdapterError("E_ADAPTER_VALIDATION", `canary info output did not parse: ${stdout.slice(0, 500)}`);
  }
  return { ...base, canaryOk: true, canary: "ok", canaryHash: sha256Hex(stdout) };
}

/** One adapter run's journal facts (adapter-matrix contract). */
export interface AdapterJournalRun {
  tool: string;
  pair: AdapterPair;
  argv: string[];
  exitCode: number;
  roots: { read: string[]; write: string[] };
  mode?: "headless";
  stderrTail?: string;
  extra?: Record<string, unknown>;
}

/**
 * Single journal helper for adapter runs. Records versions, commandsHash,
 * mode, roots, argv, and exit code in one `kind:"adapter"` entry.
 */
export async function journalAdapterRun(
  project: ProjectPaths,
  journal: JournalContext,
  actor: JournalActor,
  run: AdapterJournalRun,
): Promise<void> {
  // Callers must not already hold the project lock (withLock is not reentrant).
  await withLock(project, () =>
    appendJournal(
      project,
      { ...journal, figcraftCli: run.pair.cliVersion },
      {
        kind: "adapter",
        actor,
        payload: {
          tool: run.tool,
          cliVersion: run.pair.cliVersion,
          appVersion: run.pair.appVersion,
          commandsHash: run.pair.commandsHash,
          mode: run.mode ?? "headless",
          roots: run.roots,
          argv: run.argv,
          exit_code: run.exitCode,
          ...(run.extra ?? {}),
        },
        ...(run.stderrTail ? { stderr_tail: run.stderrTail } : {}),
      },
    ),
  );
}
