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
const distDir = path.resolve("dist");

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

// Loading a `.mts` config in the native binary needs jiti's babel transform.
// The transform source must travel *inside* `dist/zaps`, not as a sibling
// `dist/babel-<hash>.cjs` asset: the old `loader: "file"` approach left a
// Dangling build-time path that ENOENT'd on any machine but the build host.
// Removing every `dist/*.cjs` before invoking the binary forces it to rely on
// The embedded source (there should be none to begin with after the fix).
describe.skipIf(!hasBinary())("binary babel transform is self-contained", () => {
  let tmpDir: string;

  beforeEach(async () => {
    cleanStaleConfigs();
    for (const entry of fs.readdirSync(distDir)) {
      if (entry.endsWith(".cjs")) {
        fs.unlinkSync(path.join(distDir, entry));
      }
    }
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-babel-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    cleanStaleConfigs();
  });

  it("loads a TS config with no sibling babel.cjs asset present", async () => {
    await writeFile(
      path.join(tmpDir, ".zaps.mts"),
      `export function config({ define }) {
  return define({
    name: "embedded-babel",
    services: { api: { start: "true" } },
  });
}
`,
    );

    const { stdout } = await execFileAsync(binaryPath, ["config", "--json"], { cwd: tmpDir });
    const parsed = JSON.parse(stdout) as { name: string };
    expect(parsed.name).toBe("embedded-babel");
  });
});
