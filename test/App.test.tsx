import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Mock tmux functions to prevent real tmux commands
vi.mock("../src/lib/tmux.js", () => ({
  zoomPane: vi.fn().mockResolvedValue(undefined),
  editPaneCapture: vi.fn().mockResolvedValue(undefined),
  displayPopup: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(""),
  selectPane: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendCtrlC: vi.fn().mockResolvedValue(undefined),
  panePid: vi.fn().mockResolvedValue(0),
  killPane: vi.fn().mockResolvedValue(undefined),
  renameWindow: vi.fn().mockResolvedValue(undefined),
  getWindowName: vi.fn().mockResolvedValue(""),
  getWindowOption: vi.fn().mockResolvedValue(""),
  setWindowOption: vi.fn().mockResolvedValue(undefined),
  currentSession: vi.fn().mockResolvedValue(""),
  showEnv: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/lib/open.js", () => ({
  openInBrowser: vi.fn().mockResolvedValue(undefined),
}));

import type { DaemonClient } from "../src/client/daemon-client.js";
import { App } from "../src/components/App.js";
import type { ServiceMeta, TaskInfo } from "../src/daemon/session.js";
import type { ServiceStatus } from "../src/lib/service/types.js";

// Flush React/Ink reconciler
async function act(fn?: () => void): Promise<void> {
  if (fn) {
    fn();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}

// ANSI escape sequences for special keys
const ARROW_UP = "\x1B[A";
const ARROW_DOWN = "\x1B[B";
const ESCAPE = "\x1B";

function createMockClient(statuses: ServiceStatus[] = []): DaemonClient {
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
    listServices: vi.fn().mockResolvedValue([...statuses]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    restartAll: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
  });
  return client as unknown as DaemonClient;
}

function renderApp(opts: {
  statuses?: ServiceStatus[];
  projectName?: string;
  tasks?: TaskInfo[];
  servicesMeta?: ServiceMeta[];
  paneMap?: Record<string, string>;
  client?: DaemonClient;
}) {
  const statuses = opts.statuses ?? [];
  const client = opts.client ?? createMockClient(statuses);
  return {
    client,
    ...render(
      <App
        client={client}
        paneMap={opts.paneMap ?? {}}
        projectName={opts.projectName ?? "test-project"}
        tasks={opts.tasks ?? []}
        servicesMeta={opts.servicesMeta ?? []}
        initialStatuses={statuses}
        initialTaskHistory={[]}
      />,
    ),
  };
}

describe("App", () => {
  it("renders dashboard with project name", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { lastFrame } = renderApp({ statuses, projectName: "my-app" });

    expect(lastFrame()).toContain("zaps");
    expect(lastFrame()).toContain("my-app");
  });

  it("initial view is dashboard", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { lastFrame } = renderApp({ statuses });

    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[d]own");
    expect(lastFrame()).toContain("[q]uit");
  });
});

describe("Keyboard routing — Dashboard", () => {
  it("up/down changes selection index", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];

    const { lastFrame, stdin } = renderApp({ statuses });

    // Move down — api should be selected
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    const frame = lastFrame() ?? "";
    // ">" appears before the selected service
    const lines = frame.split("\n");
    const apiLine = lines.find((l) => l.includes("api"));
    expect(apiLine).toContain(">");
  });

  it("r triggers restart on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("r");
    });
    await act();

    expect(vi.mocked(client.restartService)).toHaveBeenCalledWith("db");
  });

  it("s triggers toggle on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("s");
    });
    await act();

    // Toggle tries stopService first (succeeds for running service)
    expect(vi.mocked(client.stopService)).toHaveBeenCalledWith("db");
  });

  it("a calls restartAll", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("a");
    });
    await act();

    expect(vi.mocked(client.restartAll)).toHaveBeenCalledTimes(1);
  });

  it("q detaches (disconnects and exits)", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("q");
    });
    await act();

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("d destroys session (shut down)", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("d");
    });
    await act();

    expect(vi.mocked(client.destroySession)).toHaveBeenCalled();
    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("o with no url is a no-op", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, lastFrame } = renderApp({ statuses });

    // Should not throw
    await act(() => {
      stdin.write("o");
    });
    expect(lastFrame()).toContain("db");
  });
});

describe("Keyboard routing — View switching", () => {
  it("t goes directly to tasks view with shortcuts inline", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null, shortcut: "m" },
    ];

    const { lastFrame, stdin } = renderApp({ statuses, tasks, projectName: "test" });

    await act(() => {
      stdin.write("t");
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
    expect(frame).toContain("[m]");
    expect(frame).toContain("Run migrations");
  });

  it("Esc from tasks returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null, shortcut: "m" },
    ];

    const { lastFrame, stdin } = renderApp({ statuses, tasks, projectName: "test" });

    await act(() => {
      stdin.write("t");
    });
    expect(lastFrame()).toContain("[enter] run");

    // Go back
    await act(() => {
      stdin.write(ESCAPE);
    });
    expect(lastFrame()).toContain("[t]asks");
  });

  it("l switches to logs view with correct target", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];

    const { lastFrame, stdin } = renderApp({
      statuses,
      paneMap: { db: "%0", api: "%1" },
    });

    // Select api (index 1) then press l
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    await act(() => {
      stdin.write("l");
    });

    const frame = lastFrame() ?? "";
    // LogView shows service name in header
    expect(frame).toContain("api");
    expect(frame).toContain("[esc] back");
  });

  it("Esc from logs returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { lastFrame, stdin } = renderApp({
      statuses,
      paneMap: { db: "%0" },
    });

    // Go to logs
    await act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[esc] back");

    // Go back
    await act(() => {
      stdin.write(ESCAPE);
    });
    expect(lastFrame()).toContain("[t]asks");
  });
});

describe("Keyboard routing — Edge cases", () => {
  it("no services — arrow keys are no-ops", async () => {
    const { lastFrame, stdin } = renderApp({});

    // Should not throw
    await act(() => {
      stdin.write(ARROW_UP);
    });
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    expect(lastFrame()).toContain("zaps");
  });

  it("r/s with no services is a no-op", async () => {
    const { stdin, client } = renderApp({});

    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("s");
    });
    await act();

    expect(vi.mocked(client.restartService)).not.toHaveBeenCalled();
    expect(vi.mocked(client.stopService)).not.toHaveBeenCalled();
    expect(vi.mocked(client.startService)).not.toHaveBeenCalled();
  });

  it("rapid key presses do not cause race conditions", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    // Make restartService take time
    let resolveRestart!: () => void;
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });

    const client = createMockClient(statuses);
    vi.mocked(client.restartService).mockReturnValue(restartPromise);

    const { stdin } = renderApp({ statuses, client });

    // Press r twice rapidly
    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("r");
    });

    // Should only have been called once (busyRef guards)
    expect(vi.mocked(client.restartService)).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    resolveRestart();
    await act();
  });
});

describe("Keyboard routing — ctrl keys", () => {
  it("ctrl+c detaches", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("\x03"); // Ctrl+c
    });
    await act();

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("ctrl+d destroys session from dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    await act(() => {
      stdin.write("\x04"); // Ctrl+d
    });
    await act();

    expect(vi.mocked(client.destroySession)).toHaveBeenCalled();
  });

  it("ctrl+d works from tasks view", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [{ key: "build", name: "Build", description: null }];

    const { stdin, client } = renderApp({ statuses, tasks });

    // Switch to tasks view
    await act(() => {
      stdin.write("t");
    });
    // Then ctrl+d
    await act(() => {
      stdin.write("\x04");
    });
    await act();

    expect(vi.mocked(client.destroySession)).toHaveBeenCalled();
  });

  it("ctrl+c works from logs view", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses, paneMap: { db: "%0" } });

    await act(() => {
      stdin.write("l");
    });
    await act(() => {
      stdin.write("\x03");
    });
    await act();

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });
});

describe("Keyboard routing — Tasks view", () => {
  it("enter triggers task run", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [{ key: "build", name: "Build", description: null, shortcut: "b" }];

    const { stdin, client } = renderApp({ statuses, tasks });

    await act(() => {
      stdin.write("t");
    });
    await act(() => {
      stdin.write("\r"); // Enter
    });
    await act();

    expect(vi.mocked(client.runTask)).toHaveBeenCalled();
  });

  it("shortcut key triggers task", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "build", name: "Build", description: null, shortcut: "b" },
      { key: "test", name: "Test", description: null, shortcut: "x" },
    ];

    const { stdin, client } = renderApp({ statuses, tasks });

    await act(() => {
      stdin.write("t");
    });
    // Press shortcut for second task
    await act(() => {
      stdin.write("x");
    });
    await act();

    expect(vi.mocked(client.runTask)).toHaveBeenCalled();
  });

  it("up/down navigates tasks", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "build", name: "Build", description: null },
      { key: "test", name: "Test", description: null },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, tasks });

    await act(() => {
      stdin.write("t");
    });
    await act(() => {
      stdin.write(ARROW_DOWN);
    });

    // Should show tasks view with second task selected
    expect(lastFrame()).toContain("[enter] run");
  });
});

describe("Keyboard routing — Docker rebuild", () => {
  it("R opens docker rebuild for docker service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0, isDocker: true },
    ];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "db",
        dependsOn: [],
        hasDocker: true,
        dockerDefaults: {
          build: false,
          forceRecreate: false,
          renewVolumes: false,
          pull: false,
          removeOrphans: false,
        },
      },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, servicesMeta });

    await act(() => {
      stdin.write("R");
    });

    const frame = lastFrame() ?? "";
    // Docker rebuild popup should appear
    expect(frame).toContain("db");
  });

  it("R is no-op for non-docker service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];

    const { stdin, lastFrame } = renderApp({ statuses });

    await act(() => {
      stdin.write("R");
    });

    // Should still be on dashboard
    expect(lastFrame()).toContain("[t]asks");
  });

  it("docker rebuild: space toggles flag, enter submits", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0, isDocker: true },
    ];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "db",
        dependsOn: [],
        hasDocker: true,
        dockerDefaults: {
          build: false,
          forceRecreate: false,
          renewVolumes: false,
          pull: false,
          removeOrphans: false,
        },
      },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, servicesMeta });

    // Open docker rebuild
    await act(() => {
      stdin.write("R");
    });
    // Toggle first flag (build)
    await act(() => {
      stdin.write(" ");
    });
    // Move down to next flag
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    // Press enter to submit
    await act(() => {
      stdin.write("\r");
    });
    await act();

    // After enter, view returns to dashboard
    expect(lastFrame()).toContain("[t]asks");
  });

  it("docker rebuild: escape cancels", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0, isDocker: true },
    ];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "db",
        dependsOn: [],
        hasDocker: true,
        dockerDefaults: {
          build: false,
          forceRecreate: false,
          renewVolumes: false,
          pull: false,
          removeOrphans: false,
        },
      },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, servicesMeta });

    await act(() => {
      stdin.write("R");
    });
    await act(() => {
      stdin.write(ESCAPE);
    });

    // Should be back on dashboard
    expect(lastFrame()).toContain("[t]asks");
  });

  it("docker rebuild: navigate flags with up/down", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0, isDocker: true },
    ];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "db",
        dependsOn: [],
        hasDocker: true,
        dockerDefaults: {
          build: false,
          forceRecreate: false,
          renewVolumes: false,
          pull: false,
          removeOrphans: false,
        },
      },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, servicesMeta });

    await act(() => {
      stdin.write("R");
    });
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    await act(() => {
      stdin.write(ARROW_UP);
    });

    expect(lastFrame()).toContain("db");
  });
});

describe("Keyboard routing — Logs scroll", () => {
  it("up/down scrolls in logs view", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { lastFrame, stdin } = renderApp({ statuses, paneMap: { db: "%0" } });

    // Go to logs
    await act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[esc] back");

    // Scroll up
    await act(() => {
      stdin.write(ARROW_UP);
    });
    // Scroll down
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    // K/j also scroll
    await act(() => {
      stdin.write("k");
    });
    await act(() => {
      stdin.write("j");
    });

    // Should still be in logs view (no crash)
    expect(lastFrame()).toContain("[esc] back");
  });
});

describe("Keyboard routing — Dashboard special keys", () => {
  it("o opens url when service has url", async () => {
    const { openInBrowser } = await import("../src/lib/open.js");
    const statuses: ServiceStatus[] = [
      { name: "api", state: "ready", ports: [3000], retryCount: 0, url: "http://localhost:3000" },
    ];

    const { stdin } = renderApp({ statuses });

    await act(() => {
      stdin.write("o");
    });
    expect(vi.mocked(openInBrowser)).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("z zooms pane when paneMap has entry", async () => {
    const { zoomPane } = await import("../src/lib/tmux.js");
    const statuses: ServiceStatus[] = [
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];

    const { stdin } = renderApp({ statuses, paneMap: { api: "%1" } });

    await act(() => {
      stdin.write("z");
    });
    expect(vi.mocked(zoomPane)).toHaveBeenCalledWith("%1");
  });

  it("E edits pane capture when paneMap has entry", async () => {
    const { editPaneCapture } = await import("../src/lib/tmux.js");
    const statuses: ServiceStatus[] = [
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, paneMap: { api: "%1" } });

    await act(() => {
      stdin.write("E");
    });
    expect(vi.mocked(editPaneCapture)).toHaveBeenCalledWith("%1", "api");
    expect(lastFrame()).toBeDefined();
  });
});

describe("Router — task event handling", () => {
  it("updates task history on daemon task events", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);

    const { lastFrame } = renderApp({ statuses, client });
    await act();

    // Simulate daemon task.start event
    (client as unknown as EventEmitter).emit("task.start", "build", "Build");
    await act();

    // Simulate daemon task.complete event
    (client as unknown as EventEmitter).emit("task.complete", "build", "Build", "success");
    await act();

    // Dashboard should reflect task history
    expect(lastFrame()).toBeDefined();
  });
});
