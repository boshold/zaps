import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionId } from "#src/daemon/session.js";
import { computeProjectSessionId } from "#src/lib/sentra/session-id.js";

let dir = "";

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zaps-session-id-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(extra = ""): string {
  const configPath = path.join(dir, ".zaps.mts");
  fs.writeFileSync(
    configPath,
    `export function config({ define }) {\n  return define({ name: "x", ${extra}services: { web: { start: "true" } } });\n}\n`,
  );
  return configPath;
}

describe("computeProjectSessionId", () => {
  it("matches the id the daemon mints for the invoke dir", async () => {
    const configPath = writeConfig();
    await expect(computeProjectSessionId(dir)).resolves.toBe(sessionId(configPath, dir));
  });

  it("honors the config cwd option", async () => {
    fs.mkdirSync(path.join(dir, "app"));
    const configPath = writeConfig('cwd: "app", ');
    await expect(computeProjectSessionId(dir)).resolves.toBe(
      sessionId(configPath, path.join(dir, "app")),
    );
  });

  it("throws without config", async () => {
    await expect(computeProjectSessionId(dir)).rejects.toThrow("No .zaps.mts config found");
  });
});
