import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { TasksView } from "../../src/components/TasksView.js";
import type { TaskInfo } from "../../src/daemon/session.js";
import { AppProvider } from "../../src/hooks/useZaps.js";

function createMockClient(overrides?: Partial<Record<string, unknown>>): DaemonClient {
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
    ...overrides,
  });
  return client as unknown as DaemonClient;
}

interface RenderOpts {
  tasks?: TaskInfo[];
  selectedIndex?: number;
  runTrigger?: number;
  client?: DaemonClient;
}

function renderTasksView(opts: RenderOpts) {
  const client = opts.client ?? createMockClient();
  const tasks = opts.tasks ?? [];
  return {
    client,
    ...render(
      <AppProvider
        client={client}
        paneMap={{}}
        projectName="test-project"
        tasks={tasks}
        servicesMeta={[]}
      >
        <TasksView
          selectedIndex={opts.selectedIndex ?? 0}
          runTrigger={opts.runTrigger ?? 0}
          taskShortcuts={[]}
          taskHistory={[]}
        />
      </AppProvider>,
    ),
  };
}

function rerenderTasksView(
  rerender: (tree: React.ReactElement) => void,
  client: DaemonClient,
  tasks: TaskInfo[],
  opts: { selectedIndex?: number; runTrigger?: number },
) {
  rerender(
    <AppProvider
      client={client}
      paneMap={{}}
      projectName="test-project"
      tasks={tasks}
      servicesMeta={[]}
    >
      <TasksView
        selectedIndex={opts.selectedIndex ?? 0}
        runTrigger={opts.runTrigger ?? 0}
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

  it("runs task when runTrigger changes", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const client = createMockClient();
    const { rerender } = renderTasksView({ tasks, client });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    await vi.waitFor(() => {
      expect(client.runTask).toHaveBeenCalledWith("migrate", expect.any(Object));
    });
  });

  it("does not re-run when runTrigger stays the same", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const client = createMockClient();
    const { rerender } = renderTasksView({ tasks, client, runTrigger: 0 });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 0 });
    // Give effect a chance to fire
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.runTask).not.toHaveBeenCalled();
  });

  it("handles runTask rejection gracefully", async () => {
    const client = createMockClient({
      runTask: vi.fn().mockRejectedValue(new Error("daemon crashed")),
    });
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { rerender, lastFrame } = renderTasksView({ tasks, client });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    await vi.waitFor(() => {
      expect(client.runTask).toHaveBeenCalled();
    });
    // Should not crash — frame still renders
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
  });

  it("prevents concurrent task execution (double trigger)", async () => {
    let resolveRun!: () => void;
    const client = createMockClient({
      runTask: vi.fn().mockImplementation(
        async () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveRun = () => resolve({ success: true });
          }),
      ),
    });
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { rerender } = renderTasksView({ tasks, client });

    // First trigger starts a run
    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    await vi.waitFor(() => {
      expect(client.runTask).toHaveBeenCalledTimes(1);
    });

    // Second trigger while first is still running — should be ignored
    rerenderTasksView(rerender, client, tasks, { runTrigger: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.runTask).toHaveBeenCalledTimes(1);

    // Resolve first run
    resolveRun();
  });

  it("does not run task when tasks list is empty", async () => {
    const client = createMockClient();
    const { rerender } = renderTasksView({ tasks: [], client });

    rerenderTasksView(rerender, client, [], { runTrigger: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.runTask).not.toHaveBeenCalled();
  });

  it("invokes onLine callback during task execution", async () => {
    const capturedCallbacks: {
      onLine?: (line: string) => void;
    } = {};
    const client = createMockClient({
      runTask: vi
        .fn()
        .mockImplementation(
          async (_key: string, callbacks: { onLine?: (line: string) => void }) => {
            capturedCallbacks.onLine = callbacks.onLine;
            return new Promise<{ success: boolean }>((resolve) => {
              // Invoke onLine asynchronously so React can flush
              setTimeout(() => {
                callbacks.onLine?.("output line 1");
                callbacks.onLine?.("output line 2");
                resolve({ success: true });
              }, 10);
            });
          },
        ),
    });
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { rerender, lastFrame } = renderTasksView({ tasks, client });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("output line 1");
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("output line 2");
  });

  it("invokes onProgress callback during task execution", async () => {
    const client = createMockClient({
      runTask: vi.fn().mockImplementation(
        async (
          _key: string,
          callbacks: {
            onProgress?: (taskKey: string, result: "success" | "error") => void;
          },
        ) => {
          callbacks.onProgress?.("migrate", "success");
          return Promise.resolve({ success: true });
        },
      ),
    });
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { rerender, lastFrame } = renderTasksView({ tasks, client });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    await vi.waitFor(() => {
      expect(client.runTask).toHaveBeenCalled();
    });

    // The task result status should be reflected in the rendered output
    const frame = lastFrame() ?? "";
    // TaskListPanel renders task results — just verify no crash and task is shown
    expect(frame).toContain("Run migrations");
  });
});
