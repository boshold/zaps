import { EventEmitter } from "node:events";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import type { TaskInfo } from "../../src/daemon/session.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { TasksView } from "../../src/components/TasksView.js";
import { AppProvider } from "../../src/hooks/useZaps.js";

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

function renderTasksView(opts: { tasks?: TaskInfo[]; selectedIndex?: number }) {
  const client = createMockClient();
  const tasks = opts.tasks ?? [];
  return render(
    <AppProvider
      client={client}
      paneMap={{}}
      projectName="test-project"
      tasks={tasks}
      servicesMeta={[]}
    >
      <TasksView
        selectedIndex={opts.selectedIndex ?? 0}
        runTrigger={0}
        taskShortcuts={[]}
        taskHistory={[]}
      />
    </AppProvider>,
  );
}

describe("TasksView", () => {
  it("renders all tasks", () => {
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null },
      { key: "seed", name: "Seed DB", description: null },
    ];

    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
    expect(frame).toContain("Seed DB");
  });

  it("highlights selected task", () => {
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null },
      { key: "seed", name: "Seed DB", description: null },
    ];

    const { lastFrame } = renderTasksView({ tasks, selectedIndex: 1 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("renders Tasks header", () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];

    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
  });

  it("renders help bar with controls", () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];

    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
    expect(frame).toContain("[esc] back");
  });

  it("renders empty when no tasks defined", () => {
    const { lastFrame } = renderTasksView({});
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
    // Should not crash
  });
});
