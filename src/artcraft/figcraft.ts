/**
 * FigCraft CLI adapter: fixed argv, no shell, roots always attached.
 * Operations: info + export (MVP allowlist). No run/convert/render/mcp.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { childEnv } from "../host/env.js";
import {
  assertAllowlisted,
  FIGCRAFT_CLI,
  requirePinnedPair,
  type AdapterPair,
} from "./matrix.js";
import { AdapterError } from "./matrix.js";

export interface AdapterRoots {
  read: string[];
  write: string[];
}

export interface InfoResult {
  argv: string[];
  info: unknown;
  stdout: string;
  pair: AdapterPair;
  exitCode: number;
}

export interface ExportArgs {
  file: string;
  out: string;
  node?: string;
  format?: string;
  page?: string;
  scale?: string;
}

export interface ExportResult {
  argv: string[];
  out: string;
  files: string[];
  stderrTail: string;
  pair: AdapterPair;
  exitCode: number;
}

function rootArgs(roots: AdapterRoots): string[] {
  const argv: string[] = [];
  for (const r of roots.read) argv.push("--automation-read-root", r);
  for (const r of roots.write) argv.push("--automation-write-root", r);
  return argv;
}

/** Exact argv for `info --json`. Pure (test seam). */
export function buildInfoArgv(file: string, roots: AdapterRoots): string[] {
  return ["info", "--json", "--no-system-fonts", ...rootArgs(roots), file];
}

/** Exact argv for `export`. Pure (test seam). */
export function buildExportArgv(args: ExportArgs, roots: AdapterRoots): string[] {
  const argv = ["export", "--no-system-fonts"];
  if (args.format) argv.push("--format", args.format);
  if (args.page) argv.push("--page", args.page);
  if (args.node) argv.push("--node", args.node);
  if (args.scale) argv.push("--scale", args.scale);
  argv.push("--out", args.out, ...rootArgs(roots), args.file);
  return argv;
}

function spawn(
  exe: string,
  argv: string[],
  opts: { timeoutMs?: number; retries?: number },
): Promise<{ stdout: string; stderr: string }> {
  const attempts = 1 + (opts.retries ?? 0);
  return new Promise((resolve, reject) => {
    const attempt = (n: number): void => {
      execFile(
        exe,
        argv,
        { env: childEnv(), timeout: opts.timeoutMs ?? 180000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            if (n + 1 < attempts) {
              setTimeout(() => attempt(n + 1), 200 * (n + 1));
              return;
            }
            reject(
              new AdapterError(
                "E_ADAPTER_COMMAND",
                `${exe} ${argv.join(" ")} failed: ${String(stderr).slice(-2000)}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    };
    attempt(0);
  });
}

function assertNoShell(argv: string[]): void {
  for (const a of argv) {
    if (/[;&|`$<>()\n\r]/.test(a)) {
      throw new AdapterError("E_ADAPTER_COMMAND", `argv element looks like shell metachars: ${a.slice(0, 80)}`);
    }
  }
}

export async function figcraftInfo(
  file: string,
  roots: AdapterRoots,
  exe = FIGCRAFT_CLI,
): Promise<InfoResult> {
  assertAllowlisted("info");
  // H19: pin before spawn. Reads never get a write root.
  const pair = await requirePinnedPair(exe);
  const argv = buildInfoArgv(file, { read: roots.read, write: [] });
  assertNoShell(argv);
  const { stdout } = await spawn(exe, argv, { retries: 2 });
  let info: unknown;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new AdapterError("E_ADAPTER_VALIDATION", `info output did not parse: ${stdout.slice(0, 500)}`);
  }
  return { argv: [exe, ...argv], info, stdout, pair, exitCode: 0 };
}

export async function figcraftExport(
  args: ExportArgs,
  roots: AdapterRoots,
  exe = FIGCRAFT_CLI,
): Promise<ExportResult> {
  assertAllowlisted("export");
  // H19: pin before spawn; an unsupported pair never writes output.
  const pair = await requirePinnedPair(exe);
  const argv = buildExportArgv(args, roots);
  assertNoShell(argv);
  // Writes: 0 automatic retries.
  const { stderr } = await spawn(exe, argv, { retries: 0 });
  const files = await collectOutputs(args.out);
  return { argv: [exe, ...argv], out: args.out, files, stderrTail: stderr.slice(-4096), pair, exitCode: 0 };
}

async function collectOutputs(out: string): Promise<string[]> {
  const st = await fs.stat(out);
  if (st.isDirectory()) {
    const entries = await fs.readdir(out);
    return entries.map((e) => path.join(out, e)).sort();
  }
  return [out];
}
