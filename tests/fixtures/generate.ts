/**
 * Tiny .figcraft fixture generator. Deterministic: <20 nodes, bundled fonts
 * only, no images, no network. Uses figcraft-cli run with a script of
 * verified commands (frame.create, shape.rectangle, text.create) and saves
 * via --out. The script + expected hash are versioned here.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { childEnv } from "../../src/host/env.js";
import { sha256Hex } from "../../src/design/hashes.js";

export const FIXTURE_SCRIPT = [
  { command: "frame.create", params: { name: "Tiny", width: 390, height: 844 } },
  { command: "shape.rectangle", params: { x: 16, y: 16, width: 120, height: 48, name: "Button" } },
  { command: "text.create", params: { text: "Hello", x: 16, y: 80, name: "Label" } },
];

export async function generateTinyFixture(dir: string): Promise<{ file: string; sha256: string; scriptHash: string }> {
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, "tiny.script.json");
  const file = path.join(dir, "tiny.figcraft");
  await fs.writeFile(script, JSON.stringify(FIXTURE_SCRIPT), "utf8");
  await new Promise<void>((resolve, reject) => {
    execFile(
      "figcraft-cli",
      ["run", "--no-system-fonts", "--out", file, script],
      { env: childEnv(), timeout: 120000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`fixture generate failed: ${String(stderr).slice(-2000)}`));
        else resolve();
      },
    );
  });
  const data = await fs.readFile(file);
  return { file, sha256: sha256Hex(data), scriptHash: sha256Hex(JSON.stringify(FIXTURE_SCRIPT)) };
}
