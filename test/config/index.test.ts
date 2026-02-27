import { describe, expect, it } from "vitest";

import {
  createZapsLib,
  discoverConfig,
  generateTemplate,
  loadConfig,
  projectConfigSchema,
  scaffoldConfig,
} from "../../src/config/index.js";

describe("config barrel exports", () => {
  it("exports discoverConfig", () => {
    expect(discoverConfig).toBeDefined();
  });

  it("exports loadConfig", () => {
    expect(loadConfig).toBeDefined();
  });

  it("exports createZapsLib", () => {
    expect(createZapsLib).toBeDefined();
  });

  it("exports generateTemplate", () => {
    expect(generateTemplate).toBeDefined();
  });

  it("exports scaffoldConfig", () => {
    expect(scaffoldConfig).toBeDefined();
  });

  it("exports projectConfigSchema", () => {
    expect(projectConfigSchema).toBeDefined();
  });
});
