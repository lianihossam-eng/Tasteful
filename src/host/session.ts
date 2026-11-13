/**
 * Hermetic session assembly: every createAgentSession boundary explicit.
 * `tools` is the exact PRODUCT_TOOL_NAMES allowlist (no pi built-ins,
 * read/bash/edit/write/... are never named), customTools = product tools only.
 * Settings are explicit in-memory product settings: no ~/.pi or .pi file is
 * read, and install telemetry is off so `getClientIdentity()` carries no pi
 * attribution. Provider User-Agent is overridden by the product extension's
 * `before_provider_headers` handler (see registration.ts).
 */
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { agentAuthPath, agentDir, agentSessionsDir } from "./paths.js";
import { createMockModel, createProductModelRuntime, type MockStep } from "./models.js";
import { productToolDefinitions } from "./registration.js";
import { createProductLoader } from "./product-loader.js";
import { createProductSettingsManager } from "./resources.js";
import { PRODUCT_TOOL_NAMES } from "./tools.js";
import type { JournalContext } from "./journal.js";

export interface SessionHandles {
  session: AgentSession;
  /** Exact options passed to createAgentSession (contract test seam). */
  sessionOptions: SessionOptionsUsed;
  setMockResponses?: (steps: MockStep[]) => void;
  mockCallCount?: () => number;
  dispose: () => void;
}

export interface SessionOptionsUsed {
  cwd: string;
  agentDir: string;
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
  tools: string[];
  sessionManagerKind: "in-memory" | "file";
  modelRuntimeAuthPath: string;
  modelId: string;
  customToolNames: string[];
  thinkingLevel: string;
}

export interface AssembleOptions {
  projectRoot: string;
  journal: JournalContext;
  /** "mock" uses the deterministic in-process mock model (tests). */
  model: "mock";
  mockSteps?: MockStep[];
  inMemorySession?: boolean;
}

export async function assembleSession(opts: AssembleOptions): Promise<SessionHandles> {
  const reg = { projectRoot: opts.projectRoot, journal: opts.journal };
  const settingsManager = createProductSettingsManager();
  const resourceLoader = createProductLoader(opts.projectRoot, reg);
  await resourceLoader.reload();
  const sessionManager =
    opts.inMemorySession === false
      ? SessionManager.create(opts.projectRoot, agentSessionsDir())
      : SessionManager.inMemory(opts.projectRoot);
  const modelRuntimeAuthPath = agentAuthPath();
  const modelRuntime = await createProductModelRuntime(modelRuntimeAuthPath);
  const mock = createMockModel(modelRuntime);
  const model: Model<string> = mock.model;
  if (opts.mockSteps) mock.setResponses(opts.mockSteps);
  const setMockResponses = mock.setResponses;
  const mockCallCount = mock.callCount;

  const customTools = productToolDefinitions(reg);
  const sessionOptions: SessionOptionsUsed = {
    cwd: opts.projectRoot,
    agentDir: agentDir(),
    resourceLoader,
    settingsManager,
    tools: [...PRODUCT_TOOL_NAMES],
    sessionManagerKind: sessionManager.isPersisted() ? "file" : "in-memory",
    modelRuntimeAuthPath,
    modelId: model.id,
    customToolNames: customTools.map((tool) => tool.name),
    thinkingLevel: "off",
  };
  const { session } = await createAgentSession({
    cwd: sessionOptions.cwd,
    agentDir: sessionOptions.agentDir,
    modelRuntime,
    model: model as never,
    thinkingLevel: "off",
    // Explicit allowlist = exactly the product tools. No pi built-ins
    // (read/bash/edit/write/...) are named, so none are active. An empty
    // list would disable custom tools too (see sdk.ts: allowedToolNames).
    tools: sessionOptions.tools,
    customTools: customTools as never,
    resourceLoader: sessionOptions.resourceLoader,
    sessionManager,
    settingsManager: sessionOptions.settingsManager,
  });
  const active = session.getActiveToolNames().sort();
  const expected = [...PRODUCT_TOOL_NAMES].sort();
  if (JSON.stringify(active) !== JSON.stringify(expected)) {
    session.dispose();
    throw new Error(`tool manifest mismatch: active=[${active.join(",")}] expected=[${expected.join(",")}]`);
  }
  return {
    session,
    sessionOptions,
    setMockResponses,
    mockCallCount,
    dispose: () => session.dispose(),
  };
}
