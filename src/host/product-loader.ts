/**
 * Product loader: a custom, zero-discovery ResourceLoader.
 *
 * Unlike DefaultResourceLoader, this loader never constructs a
 * DefaultPackageManager and therefore never enumerates or stats ~/.pi, .pi,
 * ~/.agents, ancestor .agents, AGENTS.md, or CLAUDE.md. It has no filesystem
 * surface at all: everything it reports is constructed in memory.
 *
 * The only extension is the product-tools inline factory, run against a
 * minimal ExtensionAPI shim that implements exactly the two registration
 * methods the factory uses (`on`, `registerTool`). Any other API method
 * throws, so an accidental dependency becomes a loud test failure rather
 * than a silent capability leak.
 */
import {
  createExtensionRuntime,
  type Extension,
  type ExtensionAPI,
  type LoadExtensionsResult,
  type PathMetadata,
  type ResourceLoader,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { productToolsExtension, type Registration } from "./registration.js";
import { TASTEFUL_SYSTEM_PROMPT } from "./resources.js";

/** Synthetic path of the single product extension. */
export const PRODUCT_EXTENSION_PATH = "<inline:tasteful-tools>";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/** Subset of extension resource paths accepted by the loader (all ignored). */
interface ProductExtensionPaths {
  skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
  promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
  themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

function unsupportedApiMethod(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`Product ExtensionAPI shim does not implement '${name}'`);
  };
}

/**
 * Run the product extension factory against a minimal API shim. Only `on`
 * and `registerTool` are provided; every other property is a throwing stub.
 */
function populateProductExtension(extension: Extension, reg: Registration): void {
  const target = {
    on(event: string, handler: HandlerFn): () => void {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
      return () => {
        const handlers = extension.handlers.get(event);
        if (!handlers) return;
        const index = handlers.indexOf(handler);
        if (index === -1) return;
        handlers.splice(index, 1);
        if (handlers.length === 0) extension.handlers.delete(event);
      };
    },
    registerTool(tool: ToolDefinition): void {
      if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
        throw new Error(`Tool "${tool.name}" must define an object parameter schema.`);
      }
      extension.tools.set(tool.name, { definition: tool, sourceInfo: extension.sourceInfo });
    },
  };
  const api = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj) return Reflect.get(obj, prop, receiver);
      if (typeof prop === "symbol") return undefined;
      return unsupportedApiMethod(String(prop));
    },
  }) as unknown as ExtensionAPI;
  productToolsExtension(reg)(api);
}

function buildProductExtension(cwd: string, reg: Registration): Extension {
  const sourceInfo: SourceInfo = {
    path: PRODUCT_EXTENSION_PATH,
    source: "inline",
    scope: "temporary",
    origin: "top-level",
    baseDir: cwd,
  };
  const extension: Extension = {
    path: PRODUCT_EXTENSION_PATH,
    resolvedPath: PRODUCT_EXTENSION_PATH,
    sourceInfo,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  populateProductExtension(extension, reg);
  return extension;
}

/**
 * Custom ResourceLoader: no discovery, no filesystem access, no ambient
 * state. Settings and model runtime are supplied separately (in-memory), so
 * this object only answers resource queries.
 */
export class ProductResourceLoader implements ResourceLoader {
  private extensionsResult: LoadExtensionsResult;

  constructor(
    private readonly cwd: string,
    private readonly reg: Registration,
  ) {
    this.extensionsResult = this.build();
  }

  private build(): LoadExtensionsResult {
    return {
      extensions: [buildProductExtension(this.cwd, this.reg)],
      errors: [],
      // A fresh runtime per load mirrors the SDK loader: AgentSession.reload()
      // invalidates the old runtime before calling resourceLoader.reload().
      runtime: createExtensionRuntime(),
    };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills(): { skills: never[]; diagnostics: never[] } {
    return { skills: [], diagnostics: [] };
  }

  getPrompts(): { prompts: never[]; diagnostics: never[] } {
    return { prompts: [], diagnostics: [] };
  }

  getThemes(): { themes: never[]; diagnostics: never[] } {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles(): { agentsFiles: never[] } {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return TASTEFUL_SYSTEM_PROMPT;
  }

  getSystemPromptSource(): { path: string } | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return [];
  }

  extendResources(_paths: ProductExtensionPaths): void {
    // Product resources are fixed; extension-provided paths are ignored.
  }

  async reload(): Promise<void> {
    this.extensionsResult = this.build();
  }
}

/** Create the product loader. Contains no filesystem or discovery code. */
export function createProductLoader(cwd: string, reg: Registration): ResourceLoader {
  return new ProductResourceLoader(cwd, reg);
}
