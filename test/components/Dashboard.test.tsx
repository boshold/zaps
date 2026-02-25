import { EventEmitter } from "node:events";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import type { TaskRunRecord } from "../../src/components/TaskRunRecord.js";
import type { ResolvedConfig } from "../../src/config/types.js";
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

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    session: "test",
    attach: vi.fn().mockResolvedValue({
      configPath: "/fake/.zaps.ts",
      projectDir: "/fake",
      paneMap: {},
      statuses: [],
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
  });
  return client as unknown as DaemonClient;
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
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
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
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    expect(lastFrame()).toContain("cool-app");
  });

  it("renders help bar", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[q]uit");
  });

  it("highlights selected service", () => {
    const statuses = [makeStatus("db", "ready"), makeStatus("api", "ready")];
    const config = makeConfig();
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={1} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("renders column headers", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
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
    const client = createMockClient();
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
      <AppProvider client={client} config={config} paneMap={{}}>
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

  it("shows action hints for selected service", () => {
    const statuses = [makeStatus("db"), makeStatus("api")];
    const config = makeConfig();
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[r]estart");
    expect(frame).toContain("[s]top");
    expect(frame).toContain("[l]ogs");
  });

  it("shows [o]pen only when selected service has url", () => {
    const withUrl = [makeStatus("db"), makeStatus("api")];
    withUrl[0].url = "http://localhost:5432";
    const withoutUrl = [makeStatus("db"), makeStatus("api")];
    const config = makeConfig();

    const { lastFrame: f1 } = render(
      <AppProvider client={createMockClient()} config={config} paneMap={{}}>
        <Dashboard statuses={withUrl} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );
    expect(f1()).toContain("[o]pen");

    const { lastFrame: f2 } = render(
      <AppProvider client={createMockClient()} config={config} paneMap={{}}>
        <Dashboard statuses={withoutUrl} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );
    expect(f2()).not.toContain("[o]pen");
  });

  it("hides recent tasks when history is empty", () => {
    const statuses = [makeStatus("db")];
    const config = makeConfig();
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={[]} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Recent Tasks");
  });
});
