import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/loader.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-loader-notice-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const filePath = path.join(tmpDir, ".zaps.ts");
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("loadConfig notice sink", () => {
  it("routes cli.warn through the injected onNotice sink", async () => {
    const configPath = writeConfig(
      `
      export function config(z) {
        z.cli.warn("heads up");
        return z.define({
          name: "notice-project",
          services: { api: { start: "npm run dev" } },
        });
      }
    `,
    );

    const notices: { level: string; message: string }[] = [];
    await loadConfig(configPath, tmpDir, (n) => notices.push(n));
    expect(notices).toEqual([{ level: "warn", message: "heads up" }]);
  });

  it("falls back to the stderr sink when no onNotice is provided", async () => {
    const configPath = writeConfig(
      `
      export function config(z) {
        z.cli.success("all good");
        return z.define({
          name: "stderr-notice",
          services: { api: { start: "npm run dev" } },
        });
      }
    `,
    );

    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await loadConfig(configPath, tmpDir);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("all good");
    stderr.mockRestore();
  });
});
