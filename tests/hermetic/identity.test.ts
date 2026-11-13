/** Identity: user-visible output and provider requests carry product branding only. */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { helpText, versionLine } from "../../src/cli/identity.js";
import { TASTEFUL_SYSTEM_PROMPT } from "../../src/host/resources.js";
import { ProductResourceLoader, createProductLoader } from "../../src/host/product-loader.js";
import { applyProductIdentityHeaders, PRODUCT_USER_AGENT } from "../../src/host/registration.js";
import { assembleSession } from "../../src/host/session.js";
import { PI_VERSION, TASTEFUL_VERSION } from "../../src/version.js";
import { tempDir } from "../helpers.js";

function assertNoPiBranding(text: string, where: string): void {
  for (const line of text.split("\n")) {
    const low = line.toLowerCase();
    // 'pi' as a standalone token (not inside other words like 'rapid')
    assert.ok(!/(^|[^a-z])pi([^a-z]|$)/.test(low), `${where}: pi branding in: ${line}`);
    assert.ok(!low.includes("pi.dev"), `${where}: pi.dev in: ${line}`);
    assert.ok(!low.includes("earendil"), `${where}: earendil in: ${line}`);
  }
}

/** Resolve an SDK internal module (export map is "." only, so resolve the package root). */
async function importSdkInternal(pkg: string, relative: string): Promise<Record<string, unknown>> {
  // import.meta.resolve, not createRequire: the package exports map has no
  // "require" condition; this is a test-only probe of unexported internals.
  const root = path.dirname(fileURLToPath(import.meta.resolve(pkg)));
  return (await import(pathToFileURL(path.join(root, relative)).href)) as Record<string, unknown>;
}

function withCleanTelemetryEnv<T>(fn: () => T): T {
  const prev = process.env.PI_TELEMETRY;
  delete process.env.PI_TELEMETRY;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = prev;
  }
}

test("--version is product-only", () => {
  const v = versionLine();
  assert.match(v, /^tasteful \d+\.\d+\.\d+$/);
  assertNoPiBranding(v, "version");
});

test("--help is product-only", () => {
  assertNoPiBranding(helpText(), "help");
});

test("system prompt is product-only", () => {
  assertNoPiBranding(TASTEFUL_SYSTEM_PROMPT, "system-prompt");
});

test("product User-Agent is product-branded", () => {
  assert.equal(PRODUCT_USER_AGENT, `tasteful/${TASTEFUL_VERSION}`);
  assertNoPiBranding(PRODUCT_USER_AGENT, "user-agent");
});

test("session settings disable install telemetry, so getClientIdentity has no pi attribution", async () => {
  const home = await tempDir("tasteful-identity-home-");
  const project = await tempDir("tasteful-identity-proj-");
  const prevHome = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = home;
  try {
    await withCleanTelemetryEnv(async () => {
      const handles = await assembleSession({
        projectRoot: project,
        journal: { tastefulVersion: TASTEFUL_VERSION, piVersion: PI_VERSION },
        model: "mock",
        inMemorySession: true,
      });
      try {
        assert.equal(handles.session.settingsManager.getEnableInstallTelemetry(), false);
        const identityMod = await importSdkInternal("@earendil-works/pi-coding-agent", "core/client-identity.js");
        const getClientIdentity = identityMod.getClientIdentity as (s: unknown) => {
          userAgent?: unknown;
          version?: string;
          attribution?: unknown;
        };
        const identity = getClientIdentity(handles.session.settingsManager);
        assert.equal(identity.attribution, null, "telemetry off must disable pi attribution");
        assert.equal(identity.version, PI_VERSION);
        const piAiIdentity = await importSdkInternal("@earendil-works/pi-ai", "utils/identity.js");
        const formatUserAgent = piAiIdentity.formatUserAgent as (i: unknown) => string;
        const sdkUa = formatUserAgent(identity);
        // Residual: the SDK still formats a pi User-Agent; the extension
        // overrides it on every request (asserted below).
        assert.match(sdkUa, /^pi\//);
      } finally {
        handles.dispose();
      }
    });
  } finally {
    if (prevHome === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevHome;
  }
});

test("product identity headers replace pi UA and delete pi attribution", () => {
  const headers: Record<string, string | null> = {
    "User-Agent": `pi/${PI_VERSION} (linux; node/22; x64)`,
    "HTTP-Referer": "https://pi.dev",
    "X-OpenRouter-Title": "pi",
    "X-OpenRouter-Categories": "cli-agent",
    "X-BILLING-INVOKE-ORIGIN": "Pi",
    "x-opencode-client": "pi",
  };
  applyProductIdentityHeaders(headers);
  assert.equal(headers["User-Agent"], PRODUCT_USER_AGENT);
  for (const name of ["HTTP-Referer", "X-OpenRouter-Title", "X-OpenRouter-Categories", "X-BILLING-INVOKE-ORIGIN", "x-opencode-client"]) {
    assert.equal(headers[name], null, `${name} must be deleted`);
  }
  assertNoPiBranding(JSON.stringify(Object.values(headers).filter((v): v is string => typeof v === "string").join("\n")), "headers");
  // case-insensitive replacement: no second UA survives
  assert.deepEqual(
    Object.keys(headers).filter((k) => k.toLowerCase() === "user-agent"),
    ["User-Agent"],
  );
});

test("product loader registers the before_provider_headers handler", async () => {
  const project = await tempDir("tasteful-identity-proj-");
  const prevHome = process.env.TASTEFUL_HOME;
  process.env.TASTEFUL_HOME = await tempDir("tasteful-identity-home-");
  try {
    const loader = createProductLoader(project, {
      projectRoot: project,
      journal: { tastefulVersion: TASTEFUL_VERSION, piVersion: PI_VERSION },
    });
    assert.ok(loader instanceof ProductResourceLoader);
    assert.ok(!(loader instanceof DefaultResourceLoader));
    await loader.reload();
    const extensions = loader.getExtensions().extensions;
    assert.equal(extensions.length, 1);
    const handlers = extensions[0]?.handlers.get("before_provider_headers") ?? [];
    assert.equal(handlers.length, 1, "one product identity handler must be registered");
    const headers: Record<string, string | null> = { "User-Agent": `pi/${PI_VERSION}` };
    await handlers[0]!({ type: "before_provider_headers", headers }, {} as never);
    assert.equal(headers["User-Agent"], PRODUCT_USER_AGENT);
  } finally {
    if (prevHome === undefined) delete process.env.TASTEFUL_HOME;
    else process.env.TASTEFUL_HOME = prevHome;
  }
});
