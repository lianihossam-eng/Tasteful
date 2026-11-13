/**
 * tasteful run: deterministic agent-wiring smoke. Assembles the real pi
 * session with explicit services and the mock model, scripts a fixed
 * `run_journal_read` tool call, and prints what executed. It does NOT reason
 * from --prompt; the prompt is passed to the session verbatim and the script
 * is fixed. Real model wiring is operator-future work (docs/scope.md).
 */
import { appendJournal } from "../host/journal.js";
import { withLock } from "../design/store.js";
import { assembleSession } from "../host/session.js";
import { makeCtx, PI_VERSION, type GlobalOpts } from "../cli/commands.js";
import { TASTEFUL_VERSION } from "../cli/identity.js";

export interface RunArgs {
  prompt: string;
  model: string;
}

export async function cmdRun(g: GlobalOpts, a: RunArgs): Promise<string> {
  if (a.model !== "mock") {
    throw new Error(`unknown model '${a.model}': MVP supports --model mock only`);
  }
  const tc = makeCtx(g.project, "agent");
  const handles = await assembleSession({
    projectRoot: g.project,
    journal: tc.journal,
    model: "mock",
  });
  try {
    // Default script: read project status via tools, then stop. Operators can
    // drive richer scripts through the session test API; the CLI run proves
    // the real agent loop executes product tools end to end.
    handles.setMockResponses!([
      { toolCalls: [{ name: "run_journal_read", arguments: { limit: 5 } }] },
      { text: "run complete" },
    ]);
    const toolCalls: string[] = [];
    const unsub = handles.session.subscribe((event) => {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent;
        if (e.type === "toolcall_end") toolCalls.push(`${e.toolCall.name}`);
      }
    });
    try {
      await handles.session.prompt(a.prompt);
    } finally {
      unsub();
    }
    const last = handles.session.getLastAssistantText();
    await withLock(tc.project, async () => {
      await appendJournal(tc.project, tc.journal, {
        kind: "command",
        actor: "agent",
        payload: {
          command: "run",
          model: "tasteful-mock",
          tasteful_version: TASTEFUL_VERSION,
          pi_version: PI_VERSION,
          tool_calls: toolCalls,
        },
      });
    });
    return `tools: ${toolCalls.join(", ") || "none"}\nlast: ${(last ?? "").slice(0, 500)}\n`;
  } finally {
    handles.dispose();
  }
}
