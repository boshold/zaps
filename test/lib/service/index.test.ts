import { describe, expect, it } from "vitest";

import {
  ServiceManager,
  buildServiceContext,
  canTransition,
  createServiceStatus,
  detectCycles,
  formatEnvForShell,
  resolveEnv,
  reverseTopoSort,
  setServiceEnv,
  shellEscape,
  topoSort,
  transition,
  waitForReady,
} from "../../../src/lib/service/index.js";

describe("service barrel exports", () => {
  it("exports state utilities", () => {
    expect(canTransition).toBeDefined();
    expect(transition).toBeDefined();
    expect(createServiceStatus).toBeDefined();
  });

  it("exports graph utilities", () => {
    expect(topoSort).toBeDefined();
    expect(detectCycles).toBeDefined();
    expect(reverseTopoSort).toBeDefined();
  });

  it("exports waitForReady", () => {
    expect(waitForReady).toBeDefined();
  });

  it("exports env utilities", () => {
    expect(buildServiceContext).toBeDefined();
    expect(resolveEnv).toBeDefined();
    expect(formatEnvForShell).toBeDefined();
    expect(shellEscape).toBeDefined();
    expect(setServiceEnv).toBeDefined();
  });

  it("exports ServiceManager", () => {
    expect(ServiceManager).toBeDefined();
  });
});
