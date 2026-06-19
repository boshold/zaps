import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { Dashboard } from "../../src/components/Dashboard.js";
import type { TaskRunRecord } from "../../src/components/TaskRunRecord.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

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
      tasks: [],
      servicesMeta: [],
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
  });
  return client as unknown as DaemonClient;
}

function renderDashboard(opts: {
  statuses: ServiceStatus[];
  projectName?: string;
  selectedIndex?: number;
  taskHistory?: TaskRunRecord[];
}) {
  const client = createMockClient();
  return render(
    <AppProvider
      client={client}
      paneMap={{}}
      projectName={opts.projectName ?? "test-project"}
      tasks={[]}
      servicesMeta={[]}
    >
      <Dashboard
        statuses={opts.statuses}
        selectedIndex={opts.selectedIndex ?? 0}
        taskHistory={opts.taskHistory ?? []}
      />
    </AppProvider>,
  );
}

describe("Dashboard", () => {
  it("renders all services", () => {
    const statuses = [
      makeStatus("db", "ready", [5432]),
      makeStatus("api", "starting", [3000]),
      makeStatus("worker", "error"),
      makeStatus("frontend", "stopped"),
    ];

    const { lastFrame } = renderDashboard({ statuses, projectName: "my-project" });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("my-project");
    expect(frame).toContain("db");
    expect(frame).toContain("api");
    expect(frame).toContain("worker");
    expect(frame).toContain("frontend");
  });

  it("renders project name in header", () => {
    const statuses = [makeStatus("db")];

    const { lastFrame } = renderDashboard({ statuses, projectName: "cool-app" });

    expect(lastFrame()).toContain("cool-app");
  });

  it("renders help bar", () => {
    const statuses = [makeStatus("db")];

    const { lastFrame } = renderDashboard({ statuses });

    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[q]uit");
  });

  it("highlights selected service", () => {
    const statuses = [makeStatus("db", "ready"), makeStatus("api", "ready")];

    const { lastFrame } = renderDashboard({ statuses, selectedIndex: 1 });

    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("renders column headers", () => {
    const statuses = [makeStatus("db")];

    const { lastFrame } = renderDashboard({ statuses });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("STATUS");
    expect(frame).toContain("NAME");
    expect(frame).toContain("PORTS");
    expect(frame).toContain("URL");
  });

  it("renders recent tasks when history provided", () => {
    const statuses = [makeStatus("db")];
    const taskHistory: TaskRunRecord[] = [
      {
        taskKey: "migrate",
        taskName: "Prisma Migrate",
        result: "success",
        timestamp: Date.now() - 120_000,
      },
      { taskKey: "build", taskName: "Build", result: "error", timestamp: Date.now() - 300_000 },
    ];

    const { lastFrame } = renderDashboard({ statuses, taskHistory });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Recent Tasks");
    expect(frame).toContain("Prisma Migrate");
    expect(frame).toContain("Build");
    expect(frame).toContain("✔");
    expect(frame).toContain("✖");
  });

  it("shows action hints for selected service", () => {
    const statuses = [makeStatus("db"), makeStatus("api")];

    const { lastFrame } = renderDashboard({ statuses });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[r]estart");
    expect(frame).toContain("[s]top");
    expect(frame).toContain("[l]ogs");
  });

  it("shows [o]pen only when selected service has url", () => {
    const withUrl = [makeStatus("db"), makeStatus("api")];
    withUrl[0].url = "http://localhost:5432";
    const withoutUrl = [makeStatus("db"), makeStatus("api")];

    const { lastFrame: f1 } = renderDashboard({ statuses: withUrl });
    expect(f1()).toContain("[o]pen");

    const { lastFrame: f2 } = renderDashboard({ statuses: withoutUrl });
    expect(f2()).not.toContain("[o]pen");
  });

  it("hides recent tasks when history is empty", () => {
    const statuses = [makeStatus("db")];

    const { lastFrame } = renderDashboard({ statuses });

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Recent Tasks");
  });

  it("reserves rows for the Recent Tasks section so the list never overflows the pane", () => {
    // 14 single-line services fit when there is no history (maxRows 17 at the
    // 24-row default), but the Recent Tasks block (title + 3 rows + margin)
    // Shrinks the budget below 14, so the list must truncate instead of
    // Overflowing the pane and blanking the alternate-screen frame.
    const statuses = Array.from({ length: 14 }, (_, i) => makeStatus(`svc-${String(i)}`));
    const taskHistory: TaskRunRecord[] = [
      { taskKey: "a", taskName: "Task A", result: "success", timestamp: Date.now() },
      { taskKey: "b", taskName: "Task B", result: "success", timestamp: Date.now() },
      { taskKey: "c", taskName: "Task C", result: "success", timestamp: Date.now() },
    ];

    const { lastFrame: withoutHistory } = renderDashboard({ statuses });
    expect(withoutHistory() ?? "").not.toContain("more");

    const { lastFrame: withHistory } = renderDashboard({ statuses, taskHistory });
    expect(withHistory() ?? "").toContain("more");
  });

  it("marks only the detached service row as detached", () => {
    const paneSvc = makeStatus("web", "ready", [3000]);
    const detachedSvc: ServiceStatus = { ...makeStatus("worker", "ready"), isDetached: true };

    const { lastFrame } = renderDashboard({ statuses: [paneSvc, detachedSvc] });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("worker");
    expect(frame).toContain("web");
    // Exactly one row carries the marker — the detached one.
    expect(frame.match(/detached/g)).toHaveLength(1);
  });
});
