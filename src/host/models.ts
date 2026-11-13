/**
 * Models: explicit ModelRuntime under ~/.tasteful + deterministic mock model
 * (faux provider) for tests. No network, no ambient credential discovery.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { agentAuthPath, agentModelsPath } from "./paths.js";

export async function createProductModelRuntime(authPath: string = agentAuthPath()): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath,
    modelsPath: agentModelsPath(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export interface MockStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "toolUse";
}

export interface MockModel {
  model: Model<string>;
  setResponses: (steps: MockStep[]) => void;
  callCount: () => number;
}

/**
 * Deterministic mock model: each scripted step becomes one assistant message.
 * Registered on the given runtime as a native provider; the returned model is
 * passed explicitly to createAgentSession.
 */
export function createMockModel(runtime: ModelRuntime): MockModel {
  const faux = fauxProvider({ provider: "tasteful-mock", api: "tasteful-mock" });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  return {
    model,
    setResponses: (steps: MockStep[]) => {
      faux.setResponses(
        steps.map((s, i) => {
          const blocks = [];
          if (s.text) blocks.push(fauxText(s.text));
          for (const tc of s.toolCalls ?? []) {
            blocks.push(fauxToolCall(tc.name, tc.arguments as JsonObject, { id: `mock-${i}-${tc.name}` }));
          }
          const hasTools = (s.toolCalls?.length ?? 0) > 0;
          return fauxAssistantMessage(blocks.length > 0 ? blocks : "done", {
            stopReason: s.stopReason ?? (hasTools ? "toolUse" : "stop"),
          });
        }),
      );
    },
    callCount: () => faux.state.callCount,
  };
}
