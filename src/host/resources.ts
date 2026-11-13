/**
 * Product resources: system prompt and settings only. Resource *loading* is
 * handled by ./product-loader.js, which never discovers or reads ambient
 * files (~/.pi, .pi, .agents, AGENTS.md, CLAUDE.md).
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export const TASTEFUL_SYSTEM_PROMPT = `You are Tasteful, a product-design agent.
You keep an explicit decision graph: typed claims, depends_on edges, change events, gates, artifact hashes.
Rules: never invent evidence; accepted needs owner, hashed evidence, validated artifact, passed gate, and human approval from a non-owner; change events reference claim ids, never prose.
Available tools: fs_list, fs_read, fs_write (approval), decision_get, decision_upsert, decision_invalidate, artifact_validate, artcraft_info, artcraft_export (approval), gate_get, gate_upsert, run_journal_read.
Be concise.`;

/**
 * Product settings, shared by the session and any consumer. Compaction and
 * retry are deterministic product choices (no background LLM work), and
 * install telemetry is off so ground-truth provider requests carry no
 * pi attribution.
 */
export const PRODUCT_SETTINGS = {
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0 },
  enableInstallTelemetry: false,
} as const;

/** In-memory product settings: no ~/.pi or .pi/settings.json is ever read. */
export function createProductSettingsManager(): SettingsManager {
  return SettingsManager.inMemory(PRODUCT_SETTINGS);
}
