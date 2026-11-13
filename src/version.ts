/**
 * Version identity: product version and installed pi-coding-agent version are
 * read from package.json at startup and asserted against the declared pin.
 * A mismatch fails loudly here instead of drifting through journals.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_PACKAGE_NAME = "tasteful-agent";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function readPackage(file: string): PackageJson {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch (err) {
    throw new Error(`cannot read package.json at ${file}: ${(err as Error).message}`);
  }
}

function walkUp(start: string, accept: (pkg: PackageJson) => boolean): string {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const pkg = readPackage(candidate);
      if (accept(pkg)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found walking up from ${start}`);
    dir = parent;
  }
}

function findProductPackage(): string {
  return walkUp(HERE, (pkg) => pkg.name === PRODUCT_PACKAGE_NAME);
}

function findPiPackage(): string {
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve(PI_PACKAGE_NAME);
  } catch {
    entry = path.join(path.dirname(findProductPackage()), "node_modules", ...PI_PACKAGE_NAME.split("/"), "package.json");
  }
  const start = statSync(entry).isFile() ? path.dirname(entry) : entry;
  return walkUp(start, (pkg) => pkg.name === PI_PACKAGE_NAME);
}

/** Exact version assert: the project pins the adapter (no ranges). */
function assertPinnedDependency(declared: string | undefined, installed: string): void {
  if (!declared) {
    throw new Error(`package.json must declare ${PI_PACKAGE_NAME}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(declared)) {
    throw new Error(
      `${PI_PACKAGE_NAME} must be exact-pinned in package.json (got '${declared}'); this project requires a verifiable pair`,
    );
  }
  if (declared !== installed) {
    throw new Error(
      `${PI_PACKAGE_NAME} ${installed} does not match the pinned ${declared} declared in package.json`,
    );
  }
}

const productPackagePath = findProductPackage();
const productPackage = readPackage(productPackagePath);
if (!productPackage.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(productPackage.version)) {
  throw new Error(`invalid product version in ${productPackagePath}: ${String(productPackage.version)}`);
}

const piPackagePath = findPiPackage();
const piPackage = readPackage(piPackagePath);
if (!piPackage.version) throw new Error(`invalid ${PI_PACKAGE_NAME} version in ${piPackagePath}`);
assertPinnedDependency(productPackage.dependencies?.[PI_PACKAGE_NAME], piPackage.version);

/** Product version, single source: package.json. */
export const TASTEFUL_VERSION: string = productPackage.version;
/** Installed pi-coding-agent version, asserted equal to the declared pin. */
export const PI_VERSION: string = piPackage.version;
export const PRODUCT_PACKAGE_PATH = productPackagePath;
export const PI_PACKAGE_PATH = piPackagePath;
