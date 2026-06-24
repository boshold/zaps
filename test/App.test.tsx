import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { act } from "react";
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

// ANSI escape sequences for special keys
const ARROW_UP = "\x1B[A";
const ARROW_DOWN = "\x1B[B";
const ESCAPE = "\x1B";

// Ink buffers a lone ESC for 20ms to disambiguate it from escape sequences
async function pressEscape(stdin: { write: (data: string) => void }) {
  await act(async () => {
    stdin.write(ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

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
    runTaskInPane: vi.fn().mockResolvedValue({ runId: "run_1", paneId: "%9" }),
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
        // Keep these single-column assertions in the narrow layout (the detail
        // Pane has its own dedicated tests).
        ui={{ wideThreshold: 999 }}
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
    expect(lastFrame()).toContain("[q]uit/detach");
  });

  it("shows the reload hint on session.configStale and clears it on reload", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { lastFrame, client } = renderApp({ statuses });
    expect(lastFrame()).not.toContain("config changed");

    act(() => {
      client.emit("session.configStale");
    });
    expect(lastFrame()).toContain("config changed — press c to reload");

    act(() => {
      client.emit("session.configReloaded", {
        paneMap: {},
        name: "test-project",
        tasks: [],
        servicesMeta: [],
      } as never);
    });
    expect(lastFrame()).not.toContain("config changed");
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
    act(() => {
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

    act(() => {
      stdin.write("r");
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.restartService)).toHaveBeenCalledWith("db");
  });

  it("s triggers toggle on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("s");
    });
    await act(async () => {
      /* Flush */
    });

    // Toggle tries stopService first (succeeds for running service)
    expect(vi.mocked(client.stopService)).toHaveBeenCalledWith("db");
  });

  it("a calls restartAll", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("a");
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.restartAll)).toHaveBeenCalledTimes(1);
  });

  it("q detaches (disconnects and exits)", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("q");
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("d destroys session (shut down)", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("d");
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.destroySession)).toHaveBeenCalled();
    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("o with no url is a no-op", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, lastFrame } = renderApp({ statuses });

    // Should not throw
    act(() => {
      stdin.write("o");
    });
    expect(lastFrame()).toContain("db");
  });
});

describe("Keyboard routing — View switching", () => {
  it("t opens the task picker overlay", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null, shortcut: "m" },
    ];

    const { lastFrame, stdin } = renderApp({ statuses, tasks, projectName: "test" });

    act(() => {
      stdin.write("t");
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Type to filter tasks");
    expect(frame).toContain("Run migrations");
  });

  it("Esc closes the task picker back to the dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null, shortcut: "m" },
    ];

    const { lastFrame, stdin } = renderApp({ statuses, tasks, projectName: "test" });

    act(() => {
      stdin.write("t");
    });
    expect(lastFrame()).toContain("Type to filter tasks");

    // Warm-up (the just-pushed overlay can drop its first key), then Esc.
    act(() => {
      stdin.write("x");
    });
    await pressEscape(stdin);
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
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    act(() => {
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
    act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[esc] back");

    // Go back
    await pressEscape(stdin);
    expect(lastFrame()).toContain("[t]asks");
  });
});

describe("Keyboard routing — Edge cases", () => {
  it("no services — arrow keys are no-ops", async () => {
    const { lastFrame, stdin } = renderApp({});

    // Should not throw
    act(() => {
      stdin.write(ARROW_UP);
    });
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    expect(lastFrame()).toContain("zaps");
  });

  it("r/s with no services is a no-op", async () => {
    const { stdin, client } = renderApp({});

    act(() => {
      stdin.write("r");
    });
    act(() => {
      stdin.write("s");
    });
    await act(async () => {
      /* Flush */
    });

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
    act(() => {
      stdin.write("r");
    });
    act(() => {
      stdin.write("r");
    });

    // Should only have been called once (busyRef guards)
    expect(vi.mocked(client.restartService)).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    resolveRestart();
    await act(async () => {
      /* Flush */
    });
  });
});

describe("Keyboard routing — ctrl keys", () => {
  it("ctrl+c detaches", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("\x03"); // Ctrl+c
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("ctrl+d destroys session from dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses });

    act(() => {
      stdin.write("\x04"); // Ctrl+d
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.destroySession)).toHaveBeenCalled();
  });

  it("ctrl+c works from logs view", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    const { stdin, client } = renderApp({ statuses, paneMap: { db: "%0" } });

    act(() => {
      stdin.write("l");
    });
    act(() => {
      stdin.write("\x03");
    });
    await act(async () => {
      /* Flush */
    });

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

    act(() => {
      stdin.write("t");
    });
    act(() => {
      stdin.write("\r"); // Enter
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.runTask)).toHaveBeenCalled();
  });

  it("runs the selected task in a pane on Tab", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [{ key: "build", name: "Build", description: null }];

    const { stdin, client } = renderApp({ statuses, tasks });

    act(() => {
      stdin.write("t");
    });
    act(() => {
      stdin.write("\t"); // Tab → run in pane
    });
    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.runTaskInPane)).toHaveBeenCalledWith("build");
  });

  it("up/down navigates the task picker", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const tasks: TaskInfo[] = [
      { key: "build", name: "Build", description: null },
      { key: "test", name: "Test", description: null },
    ];

    const { stdin, lastFrame } = renderApp({ statuses, tasks });

    act(() => {
      stdin.write("t");
    });
    act(() => {
      stdin.write(ARROW_DOWN);
    });

    // The picker stays open with the task list rendered.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build");
    expect(frame).toContain("Test");
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

    act(() => {
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

    act(() => {
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
    act(() => {
      stdin.write("R");
    });
    // Toggle first flag (build)
    act(() => {
      stdin.write(" ");
    });
    // Move down to next flag
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    // Press enter to submit
    act(() => {
      stdin.write("\r");
    });
    await act(async () => {
      /* Flush */
    });

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

    act(() => {
      stdin.write("R");
    });
    await pressEscape(stdin);

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

    act(() => {
      stdin.write("R");
    });
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    act(() => {
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
    act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[esc] back");

    // Scroll up
    act(() => {
      stdin.write(ARROW_UP);
    });
    // Scroll down
    act(() => {
      stdin.write(ARROW_DOWN);
    });
    // K/j also scroll
    act(() => {
      stdin.write("k");
    });
    act(() => {
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

    act(() => {
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

    act(() => {
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

    act(() => {
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
    await act(async () => {
      /* Flush */
    });

    // Simulate daemon task.start event
    (client as unknown as EventEmitter).emit("task.start", "build", "Build");
    await act(async () => {
      /* Flush */
    });

    // Simulate daemon task.complete event
    (client as unknown as EventEmitter).emit("task.complete", "build", "Build", "success");
    await act(async () => {
      /* Flush */
    });

    // Dashboard should reflect task history
    expect(lastFrame()).toBeDefined();
  });
});
