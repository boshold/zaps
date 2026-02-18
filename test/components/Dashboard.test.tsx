import { EventEmitter } from "node:events";

import type { TaskRunRecord } from "../../src/components/TaskRunRecord.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { Dashboard } from "../../src/components/Dashboard.js";
import { AppProvider } from "../../src/hooks/useZaps.js";

function makeConfig(name = "test-project"): ResolvedConfig {
  return {
    project: {
      name,
      services: {},
    },
    configPath: "/fake/.zaps.ts",
    projectDir: "/fake",
  };
}

function makeStatus(
  name: string,
  state: ServiceStatus["state"] = "ready",
  ports: number[] = [],
): ServiceStatus {
  return { name, state, ports, retryCount: 0 };
}

function createMockManager(statuses: ServiceStatus[]): ServiceManager {
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

describe("Dashboard", () => {
  it("renders all services", () => {
    const statuses = [
      makeStatus("db", "ready", [5432]),
      makeStatus("api", "starting", [3000]),
      makeStatus("worker", "error"),
      makeStatus("frontend", "stopped"),
    ];
    const config = makeConfig("my-project");
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("my-project");
    expect(frame).toContain("db");
    expect(frame).toContain("api");
    expect(frame).toContain("worker");
    expect(frame).toContain("frontend");
  });

  it("renders project name in header", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig("cool-app");
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    expect(lastFrame()).toContain("cool-app");
  });

  it("renders help bar", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[q]uit");
  });

  it("highlights selected service", () => {
    const statuses = [makeStatus("db", "ready"), makeStatus("api", "ready")];
    const config = makeConfig();
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={1} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("renders column headers", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("STATUS");
    expect(frame).toContain("NAME");
    expect(frame).toContain("PORTS");
    expect(frame).toContain("URL");
  });

  it("renders recent tasks when history provided", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const manager = createMockManager(statuses);
    const taskHistory: TaskRunRecord[] = [
      {
        taskKey: "migrate",
        taskName: "Prisma Migrate",
        result: "success",
        timestamp: Date.now() - 120_000,
      },
      { taskKey: "build", taskName: "Build", result: "error", timestamp: Date.now() - 300_000 },
    ];

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={taskHistory} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Recent Tasks");
    expect(frame).toContain("Prisma Migrate");
    expect(frame).toContain("Build");
    expect(frame).toContain("✔");
    expect(frame).toContain("✖");
  });

  it("hides recent tasks when history is empty", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const manager = createMockManager(statuses);

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Recent Tasks");
  });
});
