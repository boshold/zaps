import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_FILENAMES = [".local.zaps.mts", ".local.zaps.ts", ".zaps.mts", ".zaps.ts"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readTemplate(): Promise<string> {
  const templatePath = path.resolve(__dirname, "templates", "default.template.txt");
  return readFile(templatePath, "utf8");
}

async function getZapsPath(): Promise<string> {
  // Try resolving installed zaps path
  // Fallback to "zaps" bare specifier
  return "zaps";
}

/**
 * Generate config template with placeholders replaced.
 */
export async function generateTemplate(projectName?: string): Promise<string> {
  const template = await readTemplate();
  const zapsPath = await getZapsPath();
  return template
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName ?? "my-project")
    .replace(/\{\{ZAPS_PATH\}\}/g, zapsPath);
}

/**
 * Write a starter .zaps.mts config to the given directory.
 * Throws if any config variant already exists.
 * Returns the written file path.
 */
export async function scaffoldConfig(dir: string, projectName?: string): Promise<string> {
  // Check if any config already exists
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      throw new Error(`Config file already exists: ${candidate}`);
    }
  }

  const content = await generateTemplate(projectName);
  const outPath = path.join(dir, ".zaps.mts");
  await writeFile(outPath, content, "utf8");
  return outPath;
}
