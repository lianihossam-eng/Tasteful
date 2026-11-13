/**
 * pi ToolDefinition registration for the 12 product tools. Each definition
 * delegates to the pure implementation in ./tools.ts. No other tools exist.
 * The inline extension also installs the product provider-identity handler.
 */
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalJson } from "../design/hashes.js";
import {
  artifactValidate,
  artcraftExport,
  artcraftInfo,
  decisionGet,
  decisionInvalidate,
  decisionUpsert,
  fsList,
  fsRead,
  fsWrite,
  gateGet,
  gateUpsert,
  makeToolContext,
  runJournalRead,
  type ToolContext,
} from "./tools.js";
import type { JournalContext } from "./journal.js";
import { TASTEFUL_VERSION } from "../version.js";

export interface Registration {
  projectRoot: string;
  journal: JournalContext;
}

/**
 * Product provider identity. pi's request identity (`getClientIdentity`)
 * always emits a `pi/<version>` User-Agent; the only supported override is
 * the `before_provider_headers` extension event, which runs after identity
 * and auth headers are assembled and whose result is merged last.
 */
export const PRODUCT_USER_AGENT = `tasteful/${TASTEFUL_VERSION}`;

/**
 * Attribution header names pi's identity can add (OpenRouter/NVIDIA/OpenCode).
 * Canonical casing matches pi-ai; `null` deletes the header in both pi's and
 * the OpenAI SDK's header builders.
 */
const PI_ATTRIBUTION_HEADERS = [
  "HTTP-Referer",
  "X-OpenRouter-Title",
  "X-OpenRouter-Categories",
  "X-BILLING-INVOKE-ORIGIN",
  "x-opencode-client",
] as const;

/**
 * Replace pi's User-Agent with the product UA and delete any pi attribution
 * headers. `null` is pi's documented "delete this header" value, and these
 * entries win because request headers are merged after identity headers.
 */
export function applyProductIdentityHeaders(headers: Record<string, string | null>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "user-agent") delete headers[key];
  }
  headers["User-Agent"] = PRODUCT_USER_AGENT;
  for (const name of PI_ATTRIBUTION_HEADERS) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
    headers[name] = null;
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : canonicalJson(value) }],
    details: {},
  };
}

function toolError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    details: {},
    isError: true,
  };
}

async function run<T>(fn: (ctx: ToolContext) => Promise<T>, reg: Registration) {
  const ctx = makeToolContext(reg.projectRoot, reg.journal, "agent");
  try {
    return toolResult(await fn(ctx));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return toolError(e.code ?? "E_TOOL", e.message ?? String(err));
  }
}

type AnyDef = ToolDefinition;

export function productToolDefinitions(reg: Registration): AnyDef[] {
  return [
    defineTool({
      name: "fs_list",
      label: "List files",
      description: "List directory entries under the project roots.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => run((ctx) => fsList(ctx, { path: params.path }), reg),
    }),
    defineTool({
      name: "fs_read",
      label: "Read file",
      description: "Read a file under the project roots (size-limited).",
      parameters: Type.Object({ path: Type.String(), max_bytes: Type.Optional(Type.Number()) }),
      execute: async (_id, params) =>
        run((ctx) => fsRead(ctx, { path: params.path, ...(params.max_bytes !== undefined ? { max_bytes: params.max_bytes } : {}) }), reg),
    }),
    defineTool({
      name: "fs_write",
      label: "Write file",
      description: "Write a file under the project roots. Requires a prior human approval.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, params) => run((ctx) => fsWrite(ctx, { path: params.path, content: params.content }), reg),
    }),
    defineTool({
      name: "decision_get",
      label: "Get decision",
      description: "Read a decision by id.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => run((ctx) => decisionGet(ctx, { id: params.id }), reg),
    }),
    defineTool({
      name: "decision_upsert",
      label: "Upsert decision",
      description: "Create or update a decision (strict schema; accepted needs approval record + gate).",
      parameters: Type.Object({ decision: Type.Unknown(), approval_id: Type.Optional(Type.String()) }),
      execute: async (_id, params) =>
        run(
          (ctx) => decisionUpsert(ctx, { decision: params.decision, ...(params.approval_id ? { approval_id: params.approval_id } : {}) }),
          reg,
        ),
    }),
    defineTool({
      name: "decision_invalidate",
      label: "Invalidate by claim",
      description: "Apply a change event on a claim id and propagate invalidation.",
      parameters: Type.Object({
        claim_id: Type.String(),
        old_value: Type.String(),
        new_value: Type.String(),
        reason: Type.String(),
        author: Type.String(),
      }),
      execute: async (_id, params) =>
        run(
          (ctx) =>
            decisionInvalidate(ctx, {
              claim_id: params.claim_id,
              old_value: params.old_value,
              new_value: params.new_value,
              reason: params.reason,
              author: params.author,
            }),
          reg,
        ),
    }),
    defineTool({
      name: "artifact_validate",
      label: "Validate artifact",
      description: "Re-hash a recorded artifact; drift sets its decision and all reverse dependents to needs_review, demotes accepted to proposed, and clears artifact ready flags.",
      parameters: Type.Object({ decision_id: Type.String(), artifact_path: Type.String() }),
      execute: async (_id, params) =>
        run((ctx) => artifactValidate(ctx, { decision_id: params.decision_id, artifact_path: params.artifact_path }), reg),
    }),
    defineTool({
      name: "artcraft_info",
      label: "Design file info",
      description: "Inspect a design file under the project roots (read-only).",
      parameters: Type.Object({ file: Type.String() }),
      execute: async (_id, params) => run((ctx) => artcraftInfo(ctx, { file: params.file }), reg),
    }),
    defineTool({
      name: "artcraft_export",
      label: "Export design",
      description: "Export from a design file into the exports root. Requires a prior human approval.",
      parameters: Type.Object({
        file: Type.String(),
        out: Type.String(),
        node: Type.Optional(Type.String()),
        format: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) =>
        run(
          (ctx) =>
            artcraftExport(ctx, {
              file: params.file,
              out: params.out,
              ...(params.node ? { node: params.node } : {}),
              ...(params.format ? { format: params.format } : {}),
            }),
          reg,
        ),
    }),
    defineTool({
      name: "gate_get",
      label: "Get gate",
      description: "Read a gate by id.",
      parameters: Type.Object({ gate_id: Type.String() }),
      execute: async (_id, params) => run((ctx) => gateGet(ctx, { gate_id: params.gate_id }), reg),
    }),
    defineTool({
      name: "gate_upsert",
      label: "Upsert gate",
      description: "Create or update a gate (strict schema; pass needs approver!=owner + evidence).",
      parameters: Type.Object({ gate: Type.Unknown() }),
      execute: async (_id, params) => run((ctx) => gateUpsert(ctx, { gate: params.gate }), reg),
    }),
    defineTool({
      name: "run_journal_read",
      label: "Read run journal",
      description: "Read run journal entries (read-only).",
      parameters: Type.Object({ seq_from: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
      execute: async (_id, params) =>
        run(
          (ctx) =>
            runJournalRead(ctx, {
              ...(params.seq_from !== undefined ? { seq_from: params.seq_from } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            }),
          reg,
        ),
    }),
  ];
}

/** Inline extension factory: registers the product tools + provider identity. */
export function productToolsExtension(reg: Registration) {
  return (pi: ExtensionAPI): void => {
    for (const def of productToolDefinitions(reg)) {
      pi.registerTool(def);
    }
    // Runs on every provider request; make pi's identity product-only.
    pi.on("before_provider_headers", (event) => {
      applyProductIdentityHeaders(event.headers);
    });
  };
}
