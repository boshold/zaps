import { EventEmitter } from "node:events";

import type { ResolvedConfig } from "../src/config/types.js";
import type { ServiceManager } from "../src/lib/service/manager.js";
import type { ServiceStatus } from "../src/lib/service/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/components/App.js";

function makeConfig(name = "test-project"): ResolvedConfig {
  return {
    project: { name, services: {} },
    configPath: "/fake/.zaps.ts",
    projectDir: "/fake",
  };
}

function createMockManager(statuses: ServiceStatus[] = []): ServiceManager {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    getAllStatuses: vi.fn(() => [...statuses]),
    getStatus: vi.fn((name: string) => {
      const s = statuses.find((st) => st.name === name);
      if (!s) {
        throw new Error(`Unknown service: ${name}`);
      }
      return s;
    }),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  });
  return manager as unknown as ServiceManager;
}

describe("App", () => {
  it("renders dashboard with project name", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig("my-app");

    const { lastFrame } = render(<App manager={manager} config={config} paneMap={{}} />);

    expect(lastFrame()).toContain("zaps");
    expect(lastFrame()).toContain("my-app");
  });
});
