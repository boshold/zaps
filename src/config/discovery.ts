import fs from "node:fs";
import path from "node:path";

const CONFIG_FILENAMES = [
  ".local.zaps.mts",
  "local.zaps.mts",
  ".local.zaps.ts",
  "local.zaps.ts",
  ".zaps.mts",
  ".zaps.ts",
];

/**
 * Walk up from startDir to filesystem root (or optional root boundary),
 * looking for config files. Returns absolute path of first match, or null.
 */
export function discoverConfig(startDir: string, root?: string): string | null {
  let dir = path.resolve(startDir);
  const stopAt = root ? path.resolve(root) : null;

  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    if (stopAt && dir === stopAt) {
      return null;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}
