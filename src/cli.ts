/** CLI dispatch: argv in, product output out. The env-first launcher (bin.ts) is the executable entry. */
import { readFile } from "node:fs/promises";
import { scrubProcessEnv } from "./host/env.js";
import { CliError, cmdInit } from "./cli/commands.js";
import {
  cmdAccept,
  cmdAdapterCheck,
  cmdApproveDeny,
  cmdApproveGrant,
  cmdApproveList,
  cmdBrief,
  cmdDecisionCreate,
  cmdDecisionGet,
  cmdDecisionList,
  cmdExport,
  cmdFsRead,
  cmdFsWrite,
  cmdGateCreate,
  cmdGateAccept,
  cmdGateGet,
  cmdGateRevoke,
  cmdInvalidate,
  cmdStatus,
  cmdValidate,
  cmdInfo,
  cmdExportHash,
} from "./cli/commands.js";
import { cmdRun } from "./workflow/run.js";
import { helpText, versionLine } from "./cli/identity.js";

function usageError(message: string): CliError {
  return new CliError("E_USAGE", message, 2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  // A value starting with `--` is another flag, unless it is an absolute
  // path (starts with `/`) or explicitly escaped — absolute paths such as
  // /tmp/... never start with `--`, but values like `--foo` are flags.
  if (v === undefined || (v.startsWith("--") && !v.startsWith("--/"))) {
    throw usageError(`flag ${name} needs a value`);
  }
  args.splice(i, 2);
  return v;
}

function takeBool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

export async function main(argv: string[]): Promise<string> {
  // First action: no ambient pi/AI control state may influence dispatch or
  // any child process (provider identity reads PI_TELEMETRY at request time).
  scrubProcessEnv();
  const args = [...argv];
  const project = takeFlag(args, "--project") ?? process.cwd();
  if (takeBool(args, "--version")) return versionLine() + "\n";
  if (takeBool(args, "--help") || args.length === 0) return helpText();
  const cmd = args[0];
  // Commands with subcommands take args[1] as sub; the rest take flags.
  const HAS_SUB: Record<string, true> = { decision: true, gate: true, adapter: true, fs: true, approve: true };
  const sub = HAS_SUB[cmd] ? args[1] : undefined;
  const rest = HAS_SUB[cmd] ? args.slice(2) : args.slice(1);
  const g = { project };
  switch (cmd) {
    case "init": {
      return cmdInit(g, takeFlag(rest, "--name"));
    }
    case "brief": {
      const file = takeFlag(rest, "--file");
      const coverage = takeFlag(rest, "--coverage");
      if (!file || !coverage) throw usageError("brief needs --file <md> --coverage <json>");
      return cmdBrief(g, file, coverage);
    }
    case "decision": {
      if (sub === "create") {
        const file = takeFlag(rest, "--file");
        if (!file) throw usageError("decision create needs --file <json>");
        return cmdDecisionCreate(g, file, takeFlag(rest, "--approval"));
      }
      if (sub === "get") {
        const id = takeFlag(rest, "--id");
        if (!id) throw usageError("decision get needs --id <D>");
        return cmdDecisionGet(g, id);
      }
      if (sub === "list") return cmdDecisionList(g);
      throw usageError("decision: create|get|list");
    }
    case "invalidate": {
      const claim = takeFlag(rest, "--claim");
      const old = takeFlag(rest, "--old");
      const newValue = takeFlag(rest, "--new");
      const reason = takeFlag(rest, "--reason");
      const author = takeFlag(rest, "--author");
      if (!claim || !old || !newValue || !reason || !author) {
        throw usageError("invalidate needs --claim --old --new --reason --author");
      }
      return cmdInvalidate(g, { claim, old, newValue, reason, author });
    }
    case "gate": {
      if (sub === "create") {
        const file = takeFlag(rest, "--file");
        if (!file) throw usageError("gate create needs --file <json>");
        return cmdGateCreate(g, file, takeFlag(rest, "--approval"));
      }
      if (sub === "accept") {
        const id = takeFlag(rest, "--id");
        const file = takeFlag(rest, "--file");
        const approver = takeFlag(rest, "--approver");
        if (!approver) throw usageError("gate accept needs --approver <email>");
        if ((id === undefined) === (file === undefined)) {
          throw usageError("gate accept needs exactly one of --id <G> or --file <json>");
        }
        return cmdGateAccept(g, { ...(id !== undefined ? { id } : {}), ...(file !== undefined ? { file } : {}) }, approver);
      }
      if (sub === "get") {
        const id = takeFlag(rest, "--id");
        if (!id) throw usageError("gate get needs --id <G>");
        return cmdGateGet(g, id);
      }
      if (sub === "revoke") {
        const id = takeFlag(rest, "--id");
        const approver = takeFlag(rest, "--approver");
        if (!id || !approver) throw usageError("gate revoke needs --id <G> --approver <email>");
        return cmdGateRevoke(g, id, approver);
      }
      throw usageError("gate: create|accept|get|revoke");
    }
    case "validate": {
      const decision = takeFlag(rest, "--decision");
      const artifact = takeFlag(rest, "--artifact");
      if (!decision || !artifact) throw usageError("validate needs --decision <D> --artifact <path>");
      return cmdValidate(g, decision, artifact);
    }
    case "adapter": {
      if (sub === "check") return cmdAdapterCheck(g, takeFlag(rest, "--canary"));
      throw usageError("adapter: check");
    }
    case "export": {
      const file = takeFlag(rest, "--file");
      const out = takeFlag(rest, "--out");
      if (!file || !out) throw usageError("export needs --file <fig> --out <path>");
      return cmdExport(g, { file, out, node: takeFlag(rest, "--node"), format: takeFlag(rest, "--format") });
    }
    case "info": {
      const file = takeFlag(rest, "--file");
      if (!file) throw usageError("info needs --file <fig>");
      return cmdInfo(g, file);
    }
    case "approve": {
      if (sub === "--list" || sub === "list") {
        if (rest.length > 0) throw usageError(`approve --list takes no further arguments: ${rest.join(" ")}`);
        return cmdApproveList(g);
      }
      const mode = sub === "--grant" || sub === "grant" ? "grant" : sub === "--deny" || sub === "deny" ? "deny" : undefined;
      if (mode === undefined) {
        throw usageError(
          "approve: --list | --grant|--deny --tool <t> --target <tgt> --content <text>|--content-file <f> [--params-json <json>] [--approver <email>]",
        );
      }
      const tool = takeFlag(rest, "--tool");
      const target = takeFlag(rest, "--target");
      const contentFlag = takeFlag(rest, "--content");
      const contentFile = takeFlag(rest, "--content-file");
      const paramsJson = takeFlag(rest, "--params-json");
      const approver = takeFlag(rest, "--approver") ?? "operator@tasteful";
      if (!tool || !target || (contentFlag === undefined && contentFile === undefined)) {
        throw usageError("approve needs --tool <t> --target <tgt> and --content <text> or --content-file <file>");
      }
      if (contentFlag !== undefined && contentFile !== undefined) {
        throw usageError("approve: --content and --content-file are mutually exclusive");
      }
      let content = contentFlag ?? "";
      if (contentFile !== undefined) {
        try {
          content = await readFile(contentFile, "utf8");
        } catch (err) {
          throw new CliError("E_USAGE", `cannot read --content-file: ${(err as Error).message}`, 2);
        }
      }
      let params: unknown = null;
      if (paramsJson !== undefined) {
        try {
          params = JSON.parse(paramsJson) as unknown;
        } catch {
          throw usageError("approve --params-json must be valid JSON");
        }
      }
      if (rest.length > 0) throw usageError(`unexpected arguments: ${rest.join(" ")}`);
      const input = { tool, target, content, params, approver };
      return mode === "grant" ? cmdApproveGrant(g, input) : cmdApproveDeny(g, input);
    }
    case "accept": {
      const decision = takeFlag(rest, "--decision");
      const file = takeFlag(rest, "--file");
      const approver = takeFlag(rest, "--approver");
      if (!approver) throw usageError("accept needs --approver <email>");
      if ((decision === undefined) === (file === undefined)) {
        throw usageError("accept needs exactly one of --decision <D> or --file <json>");
      }
      return cmdAccept(g, { ...(decision !== undefined ? { decision } : {}), ...(file !== undefined ? { file } : {}) }, approver);
    }
    case "fs": {
      if (sub === "read") {
        const file = takeFlag(rest, "--file");
        if (!file) throw usageError("fs read needs --file <path>");
        return cmdFsRead(g, file);
      }
      if (sub === "write") {
        const file = takeFlag(rest, "--file");
        const content = takeFlag(rest, "--content");
        const contentFile = takeFlag(rest, "--content-file");
        const approver = takeFlag(rest, "--approver") ?? "operator@tasteful";
        if (!file || (content === undefined && !contentFile)) {
          throw usageError("fs write needs --file <path> --content <text>|--content-file <f>");
        }
        let text = content ?? "";
        if (contentFile) text = await readFile(contentFile, "utf8");
        return cmdFsWrite(g, file, text, approver);
      }
      throw usageError("fs: read|write");
    }
    case "run": {
      const prompt = takeFlag(rest, "--prompt");
      const model = takeFlag(rest, "--model") ?? "mock";
      if (!prompt) throw usageError("run needs --prompt <text>");
      return cmdRun(g, { prompt, model });
    }
    case "status": {
      return cmdStatus(g, rest.includes("--json"));
    }
    case "hash": {
      const file = takeFlag(rest, "--file");
      if (!file) throw usageError("hash needs --file <path>");
      return cmdExportHash(g, file);
    }
    default:
      throw usageError(`unknown command '${cmd}'`);
  }
}

/**
 * CLI driver: print the dispatch result, or report a CliError and exit with
 * its code. Importing this module has no effect; only the launcher (bin.ts)
 * calls runCli after scrubbing the environment before the SDK import.
 */
export async function runCli(argv: string[]): Promise<void> {
  try {
    process.stdout.write(await main(argv));
  } catch (err: unknown) {
    const e = err as CliError;
    process.stderr.write(`${e.code ?? "E_UNKNOWN"}: ${e.message ?? String(err)}\n`);
    process.exit(e.exitCode ?? 3);
  }
}
