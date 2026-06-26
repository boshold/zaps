import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasBinary } from "../helpers/skip.js";

const execFileAsync = promisify(execFile);
const binaryPath = path.resolve("dist/zaps");

// Config filenames that discoverConfig searches for
const CONFIG_FILENAMES = [
  ".local.zaps.mts",
  "local.zaps.mts",
  ".local.zaps.ts",
  "local.zaps.ts",
  ".zaps.mts",
  ".zaps.ts",
];

function cleanStaleConfigs(): void {
  for (const name of CONFIG_FILENAMES) {
    try {
      fs.unlinkSync(path.join(os.tmpdir(), name));
    } catch {
      // Doesn't exist
    }
  }
}

async function configName(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(binaryPath, ["config", "--json"], { cwd });
  return (JSON.parse(stdout) as { name: string }).name;
}

describe.skipIf(!hasBinary())("binary jiti reload", () => {
  let tmpDir: string;

  beforeEach(async () => {
    cleanStaleConfigs();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-jiti-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    cleanStaleConfigs();
  });

  it("re-evaluates a transitively imported helper across reloads", async () => {
    await writeFile(path.join(tmpDir, "helper.mts"), `export const projectName = "first";\n`);
    await writeFile(
      path.join(tmpDir, ".zaps.mts"),
      `import { projectName } from "./helper.mts";
export function config({ define }) {
  return define({
    name: projectName,
    services: { api: { start: "npm run dev" } },
  });
}
`,
    );

    expect(await configName(tmpDir)).toBe("first");

    await writeFile(path.join(tmpDir, "helper.mts"), `export const projectName = "second";\n`);

    expect(await configName(tmpDir)).toBe("second");
  });
});
