#!/usr/bin/env node
/**
 * Tasteful launcher. The first and only static import is the env helper, so
 * ambient PI_* / AI control state is scrubbed before any SDK module (and thus
 * any package/config resolution) is evaluated.
 */
import { scrubProcessEnv } from "./host/env.js";

// Capture before scrubbing so the operator sees why their override was
// ignored; the value itself is never used for path resolution.
const ignoredPackageDir = process.env.PI_PACKAGE_DIR;

scrubProcessEnv();

if (ignoredPackageDir !== undefined) {
  process.stderr.write(`TASTEFUL: ignoring PI_PACKAGE_DIR=${ignoredPackageDir}\n`);
}

// Dynamic import is required here: a static import of cli.js would evaluate
// the SDK's module graph (and any import-time config resolution) before the
// scrub above runs.
const { runCli } = await import("./cli.js");
await runCli(process.argv.slice(2));
