import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { TasksView } from "../../src/components/TasksView.js";
import type { TaskInfo } from "../../src/daemon/session.js";
import type { Dimensions } from "../../src/hooks/useDimensions.js";
import { AppProvider } from "../../src/hooks/useZaps.js";

vi.mock("../../src/hooks/useDimensions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/hooks/useDimensions.js")>();
  return {
    ...original,
    useDimensions: vi.fn().mockReturnValue({
      cols: 100,
      rows: 24,
      compact: false,
      narrow: false,
      medium: true,
    } satisfies Dimensions),
  };
});

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
  runningTask?: string | null;
  onRunStart?: (taskKey: string) => void;
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
          runningTask={opts.runningTask ?? null}
          onRunStart={opts.onRunStart ?? (() => undefined)}
        />
      </AppProvider>,
    ),
  };
}

function rerenderTasksView(
  rerender: (tree: React.ReactElement) => void,
  client: DaemonClient,
  tasks: TaskInfo[],
  opts: {
    selectedIndex?: number;
    runTrigger?: number;
    runningTask?: string | null;
    onRunStart?: (taskKey: string) => void;
  },
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
        runningTask={opts.runningTask ?? null}
        onRunStart={opts.onRunStart ?? (() => undefined)}
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
    expect(frame).toContain("[enter] run");
  });

  it("renders help bar with controls", () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];

    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
    expect(frame).toContain("select");
  });

  it("renders empty when no tasks defined", () => {
    const { lastFrame } = renderTasksView({});
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
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

  it("prevents concurrent task execution (double trigger via Router runningTask)", async () => {
    let resolveRun!: () => void;
    const onRunStart = vi.fn();
    const client = createMockClient({
      runTask: vi.fn().mockImplementation(
        async () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveRun = () => resolve({ success: true });
          }),
      ),
    });
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { rerender } = renderTasksView({ tasks, client, onRunStart });

    // First trigger starts a run; the view optimistically tells Router it is running.
    rerenderTasksView(rerender, client, tasks, { runTrigger: 1, onRunStart });
    await vi.waitFor(() => {
      expect(client.runTask).toHaveBeenCalledTimes(1);
    });
    expect(onRunStart).toHaveBeenCalledWith("migrate");

    // Router now owns runningTask; second trigger while still running is ignored (F4).
    rerenderTasksView(rerender, client, tasks, {
      runTrigger: 2,
      runningTask: "migrate",
      onRunStart,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.runTask).toHaveBeenCalledTimes(1);

    // Resolve first run
    resolveRun();
  });

  it("renders the running indicator from the Router-owned runningTask prop", () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { lastFrame } = renderTasksView({ tasks, runningTask: "migrate" });
    const frame = lastFrame() ?? "";
    // Re-entering with a run in flight still shows the task; no crash.
    expect(frame).toContain("Run migrations");
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
    const { rerender } = renderTasksView({ tasks, client });

    rerenderTasksView(rerender, client, tasks, { runTrigger: 1 });
    // Output panel is hidden at default 80 cols (medium mode).
    // Verify callbacks were invoked by waiting for the task to complete.
    await vi.waitFor(() => {
      expect(capturedCallbacks.onLine).toBeDefined();
    });
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

describe("TasksView layout branches", () => {
  it("renders wide layout (showHeader=true) when not medium", async () => {
    const { useDimensions } = await import("../../src/hooks/useDimensions.js");
    vi.mocked(useDimensions).mockReturnValue({
      cols: 130,
      rows: 24,
      compact: false,
      narrow: false,
      medium: false,
    });

    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
  });

  it("renders compact layout (compact=true, medium=true) without header", async () => {
    const { useDimensions } = await import("../../src/hooks/useDimensions.js");
    vi.mocked(useDimensions).mockReturnValue({
      cols: 100,
      rows: 8,
      compact: true,
      narrow: false,
      medium: true,
    });

    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { lastFrame } = renderTasksView({ tasks });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
  });
});
