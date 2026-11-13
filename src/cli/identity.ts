/** Product identity. Single source for --version/--help output. */
import { TASTEFUL_VERSION } from "../version.js";

export { TASTEFUL_VERSION };
export const TASTEFUL_NAME = "tasteful";
export const TASTEFUL_SUMMARY = "Tasteful product-design agent (FigCraft MVP)";

export function versionLine(): string {
  return `${TASTEFUL_NAME} ${TASTEFUL_VERSION}`;
}

export function helpText(): string {
  return `${TASTEFUL_NAME} ${TASTEFUL_VERSION} — ${TASTEFUL_SUMMARY}

Usage: tasteful <command> [options]

Commands:
  init [--project <dir>]                 Create .tasteful/ project state
  brief --file <md> --coverage <json>    Ingest brief + coverage matrix
  decision create --file <json> [--approval <id>]
                                         Create/update a decision
  decision get --id <D>                  Show a decision
  decision list                          List decisions
  invalidate --claim <C> --old <a> --new <b> --reason <r> --author <a>
                                         Apply a change event
  gate create --file <json> [--approval <digest>]
                                         Create/update a gate (pass needs approval)
  gate get --id <G>                      Show a gate
  gate accept (--id <G> | --file <json>) --approver <email>
                                         Record a human gate-pass approval
  gate revoke --id <G> --approver <email>
                                         Revoke a pass gate (demotes dependents)
  validate --decision <D> --artifact <path>
                                         Run recorded checks; drift/checks demote
  adapter check [--canary <file>]        Version handshake + canary
  info --file <fig>                      Read-only FigCraft info (JSON)
  export --file <fig> --out <path> [--node <n>] [--format <f>]
                                         Confined FigCraft export
  approve --list | --grant|--deny --tool <t> --target <tgt>
          (--content <text>|--content-file <f>) [--params-json <json>] [--approver <email>]
                                         Interactive approvals (prints digest)
  accept (--decision <D> | --file <json>) --approver <email>
                                         Record a content-bound human acceptance
  fs read --file <path>                  Read a project file (confined)
  fs write --file <path> (--content <text>|--content-file <f>) [--approver <email>]
                                         Write a project file (approval-gated)
  hash --file <path>                     Print sha256 of a project file
  run --prompt <text> [--model mock]     Agent wiring smoke (mock model, scripted tools)
  status [--json]                        Project state

Global:
  --project <dir>   Project root (default: cwd)
  --version         Print version
  --help            Print this help

Exit codes: 0 ok · 2 usage · 3 validation · 4 confinement · 5 version · 6 lock busy
`;
}
