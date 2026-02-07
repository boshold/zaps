import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverConfig } from "../../src/config/discovery.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverConfig", () => {
  it("finds .zaps.ts two levels up", () => {
    const configPath = path.join(tmpDir, ".zaps.ts");
    fs.writeFileSync(configPath, "export default {}");

    const nested = path.join(tmpDir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    expect(discoverConfig(nested)).toBe(configPath);
  });

  it(".local.zaps.ts wins over .zaps.ts in same dir", () => {
    const localConfig = path.join(tmpDir, ".local.zaps.ts");
    const normalConfig = path.join(tmpDir, ".zaps.ts");
    fs.writeFileSync(localConfig, "export default {}");
    fs.writeFileSync(normalConfig, "export default {}");

    expect(discoverConfig(tmpDir)).toBe(localConfig);
  });

  it("returns null when no config exists", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    // Walk up will eventually hit root with no config
    // We test by starting from tmpDir which has no config
    expect(discoverConfig(emptyDir)).toBeNull();
  });

  it("finds config in current dir immediately", () => {
    const configPath = path.join(tmpDir, ".zaps.mts");
    fs.writeFileSync(configPath, "export default {}");

    expect(discoverConfig(tmpDir)).toBe(configPath);
  });

  it(".mts takes priority over .ts", () => {
    const mtsConfig = path.join(tmpDir, ".zaps.mts");
    const tsConfig = path.join(tmpDir, ".zaps.ts");
    fs.writeFileSync(mtsConfig, "export default {}");
    fs.writeFileSync(tsConfig, "export default {}");

    expect(discoverConfig(tmpDir)).toBe(mtsConfig);
  });

  it(".local.zaps.mts takes highest priority", () => {
    fs.writeFileSync(path.join(tmpDir, ".local.zaps.mts"), "");
    fs.writeFileSync(path.join(tmpDir, ".local.zaps.ts"), "");
    fs.writeFileSync(path.join(tmpDir, ".zaps.mts"), "");
    fs.writeFileSync(path.join(tmpDir, ".zaps.ts"), "");

    expect(discoverConfig(tmpDir)).toBe(path.join(tmpDir, ".local.zaps.mts"));
  });
});
