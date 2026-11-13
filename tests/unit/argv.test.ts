import { throwsWithCode } from "../assert-code.js";
/** Adapter argv construction: exact arrays, roots, no shell, denylist. */
import assert from "node:assert/strict";
import test from "node:test";
import { buildExportArgv, buildInfoArgv } from "../../src/artcraft/figcraft.js";
import { assertAllowlisted, buildCanaryInfoArgv } from "../../src/artcraft/matrix.js";

const ROOTS = { read: ["/proj"], write: ["/proj/.tasteful/exports"] };

test("info argv is exact", () => {
  assert.deepEqual(buildInfoArgv("/proj/a.figcraft", ROOTS), [
    "info", "--json", "--no-system-fonts",
    "--automation-read-root", "/proj",
    "--automation-write-root", "/proj/.tasteful/exports",
    "/proj/a.figcraft",
  ]);
});

test("export argv is exact with node+format", () => {
  assert.deepEqual(
    buildExportArgv({ file: "/proj/a.figcraft", out: "/proj/.tasteful/exports/x.png", node: "12", format: "png" }, ROOTS),
    [
      "export", "--no-system-fonts",
      "--format", "png",
      "--node", "12",
      "--out", "/proj/.tasteful/exports/x.png",
      "--automation-read-root", "/proj",
      "--automation-write-root", "/proj/.tasteful/exports",
      "/proj/a.figcraft",
    ],
  );
});

test("non-allowlisted op rejected pre-exec", () => {
  throwsWithCode(() => assertAllowlisted("run"), "E_NOT_ALLOWLISTED");
  throwsWithCode(() => assertAllowlisted("convert"), "E_NOT_ALLOWLISTED");
  assertAllowlisted("info");
  assertAllowlisted("export");
});

test("canary info argv carries read roots only", () => {
  const canary = "/proj/canaries/canary.figcraft";
  assert.deepEqual(buildCanaryInfoArgv(canary), [
    "info", "--json", "--no-system-fonts",
    "--automation-read-root", "/proj/canaries",
    canary,
  ]);
  assert.deepEqual(buildCanaryInfoArgv(canary, ["/shared/figcraft"]), [
    "info", "--json", "--no-system-fonts",
    "--automation-read-root", "/proj/canaries",
    "--automation-read-root", "/shared/figcraft",
    canary,
  ]);
  assert.ok(!buildCanaryInfoArgv(canary, ["/shared/figcraft"]).includes("--automation-write-root"));
});

test("no shell metacharacters in argv", () => {
  for (const argv of [buildInfoArgv("/p/a.figcraft", ROOTS), buildExportArgv({ file: "/p/a.figcraft", out: "/p/o.png" }, ROOTS)]) {
    for (const a of argv) assert.ok(!/[;&|`$<>()\n\r]/.test(a), a);
  }
});
