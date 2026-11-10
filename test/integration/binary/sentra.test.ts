import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hasBinary } from "../helpers/skip.js";

const binaryPath = path.resolve("dist/zaps");

describe.skipIf(!hasBinary())("binary sentra", () => {
  it("opens SQLite storage with node:sqlite from outside the repo", () => {
    const output = execFileSync(binaryPath, [], {
      cwd: "/",
      encoding: "utf8",
      env: { ...process.env, ZAPS_SENTRA_SMOKE: "1" },
    });
    expect(output.trim()).toBe("driver=node");
  });
});
