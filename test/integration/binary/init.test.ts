import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

/**
 * Remove any stale zaps config files from /tmp so discoverConfig
 * doesn't find them when walking up from the test's tmpDir.
 */
function cleanStaleConfigs(): void {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(os.tmpdir(), name);
    try {
      fs.unlinkSync(candidate);
    } catch {
      // Doesn't exist
    }
  }
}

describe.skipIf(!hasBinary())("binary init", () => {
  let tmpDir: string;

  beforeEach(async () => {
    cleanStaleConfigs();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-init-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    cleanStaleConfigs();
  });

  it("scaffolds .zaps.mts config file", async () => {
    const { stdout } = await execFileAsync(binaryPath, ["init"], { cwd: tmpDir });

    expect(stdout).toContain(".zaps.mts");

    const files = await readdir(tmpDir);
    expect(files).toContain(".zaps.mts");
  });

  it("fails if config already exists", async () => {
    // First init
    await execFileAsync(binaryPath, ["init"], { cwd: tmpDir });

    // Second init should fail
    await expect(execFileAsync(binaryPath, ["init"], { cwd: tmpDir })).rejects.toThrow();
  });
});
