import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import defaultTemplate from "./templates/default.template.js";

const CONFIG_FILENAMES = [
  ".local.zaps.mts",
  "local.zaps.mts",
  ".local.zaps.ts",
  "local.zaps.ts",
  ".zaps.mts",
  ".zaps.ts",
];

/**
 * Resolve the directory of the installed `@bosdev/zaps` package so a scaffolded
 * config's `import type { Library } from "..."` resolves for global/native
 * installs where a bare `"@bosdev/zaps"` specifier is not in the project's
 * `node_modules` (G8). Resolves `@bosdev/zaps/package.json` (an explicit subpath
 * that works without an `exports`/`main` field) via `createRequire().resolve` (a
 * node builtin available in all three runtimes — tsx dev, node bundle, bun
 * native binary) and returns its directory; the package's `types` field then
 * points the editor/typechecker at the declarations. Falls back to the bare
 * `"@bosdev/zaps"` specifier on any failure (e.g. `@bosdev/zaps` is a normal
 * local dependency, or resolution is unavailable) so it never crashes.
 *
 * @internal Exported for testing.
 */
export function getZapsPath(): string {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@bosdev/zaps/package.json"));
  } catch {
    return "@bosdev/zaps";
  }
}

/**
 * Generate config template with placeholders replaced.
 */
export async function generateTemplate(): Promise<string> {
  const template = defaultTemplate;
  const zapsPath = getZapsPath();
  return template.replace(/\{\{ZAPS_PATH\}\}/g, zapsPath);
}

/**
 * Write a starter .zaps.mts config to the given directory.
 * Throws if any config variant already exists.
 * Returns the written file path.
 */
export async function scaffoldConfig(dir: string): Promise<string> {
  // Check if any config already exists
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      throw new Error(`Config file already exists: ${candidate}`);
    }
  }

  const content = await generateTemplate();
  const outPath = path.join(dir, ".zaps.mts");
  await writeFile(outPath, content, "utf8");
  return outPath;
}
