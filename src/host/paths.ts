/** Product paths: TASTEFUL_HOME > os.homedir(). Never ~/.pi. */
import * as os from "node:os";
import * as path from "node:path";

export const PRODUCT = "tasteful";
export const AGENT_SUBDIR = ".tasteful";
export const AGENT_DIR_NAME = "agent";

export function tastefulHome(): string {
  const override = process.env.TASTEFUL_HOME;
  if (override && override.length > 0) return override;
  return os.homedir();
}

/** ~/.tasteful/agent (or $TASTEFUL_HOME/.tasteful/agent). */
export function agentDir(): string {
  return path.join(tastefulHome(), AGENT_SUBDIR, AGENT_DIR_NAME);
}

export function agentSessionsDir(): string {
  return path.join(agentDir(), "sessions");
}

export function agentAuthPath(): string {
  return path.join(agentDir(), "auth.json");
}

export function agentModelsPath(): string {
  return path.join(agentDir(), "models.json");
}

export function agentSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}
