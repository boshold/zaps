import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import defaultTemplate from "./templates/default.template.js";

const CONFIG_FILENAMES = [".local.zaps.mts", ".local.zaps.ts", ".zaps.mts", ".zaps.ts"];

async function getZapsPath(): Promise<string> {
  // Try resolving installed zaps path
  // Fallback to "zaps" bare specifier
  return "zaps";
}

/**
 * Generate config template with placeholders replaced.
 */
export async function generateTemplate(): Promise<string> {
  const template = defaultTemplate;
  const zapsPath = await getZapsPath();
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
