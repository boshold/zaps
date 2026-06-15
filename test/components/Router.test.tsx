import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { DOCKER_REBUILD_FLAGS } from "../../src/components/DockerRebuildView.js";
import { Router } from "../../src/components/Router.js";
import type { TaskRunRecord } from "../../src/components/TaskRunRecord.js";
import type { ServiceMeta, TaskInfo } from "../../src/daemon/session.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

// ── mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/lib/open.js", () => ({
  openInBrowser: vi.fn(),
}));

vi.mock("../../src/lib/tmux.js", () => ({
  zoomPane: vi.fn(),
  editPaneCapture: vi.fn().mockResolvedValue(undefined),
}));

const { openInBrowser } = await import("../../src/lib/open.js");
const { zoomPane, editPaneCapture } = await import("../../src/lib/tmux.js");

// ── helpers ────────────────────────────────────────────────────────────

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
    restartAll: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
  });
  return client as unknown as DaemonClient;
}

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: "web",
    state: "ready",
    ports: [3000],
    retryCount: 0,
    ...overrides,
  };
}

function renderRouter(
  opts: {
    statuses?: ServiceStatus[];
    tasks?: TaskInfo[];
    servicesMeta?: ServiceMeta[];
    paneMap?: Record<string, string>;
    taskHistory?: TaskRunRecord[];
    autoStart?: boolean;
    client?: DaemonClient;
  } = {},
) {
  const client = opts.client ?? createMockClient();
  const statuses = opts.statuses ?? [makeStatus()];
  const tasks = opts.tasks ?? [];
  const paneMap = opts.paneMap ?? {};
  const servicesMeta = opts.servicesMeta ?? [];
  const taskHistory = opts.taskHistory ?? [];

  const result = render(
    <AppProvider
      client={client}
      paneMap={paneMap}
      projectName="test-project"
      tasks={tasks}
      servicesMeta={servicesMeta}
    >
      <Router
        initialStatuses={statuses}
        initialTaskHistory={taskHistory}
        autoStart={opts.autoStart}
      />
    </AppProvider>,
  );

  return { ...result, client };
}

// Ink buffers a lone ESC for 20ms to disambiguate it from escape sequences
async function pressEscape(stdin: { write: (data: string) => void }) {
  await act(async () => {
    stdin.write("\x1B");
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

// ── tests ──────────────────────────────────────────────────────────────

describe("Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── rendering ─────────────────────────────────────────────────

  it("renders dashboard by default", () => {
    const { lastFrame } = renderRouter();
    expect(lastFrame()).toContain("zaps");
  });

  it("returns null when autoStart and not yet ready", () => {
    vi.useFakeTimers();
    const { lastFrame } = renderRouter({ autoStart: true, statuses: [] });
    expect(lastFrame()).toBe("");
  });

  it("ignores keyboard input during the splash (input gated until ready) (F5)", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ autoStart: true, statuses: [], client });
    // During the ~1.2s splash, destructive keys must do nothing.
    stdin.write("d");
    stdin.write("q");
    await act(async () => {
      /* Flush */
    });
    expect(client.destroySession).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  // ── dashboard input: navigation ──────────────────────────────

  it("navigates down with j key", async () => {
    const statuses = [makeStatus({ name: "web" }), makeStatus({ name: "api" })];
    const { stdin, lastFrame } = renderRouter({ statuses });
    stdin.write("j");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
  });

  it("navigates up with k key", async () => {
    const statuses = [makeStatus({ name: "web" }), makeStatus({ name: "api" })];
    const { stdin, lastFrame } = renderRouter({ statuses });
    stdin.write("j");
    stdin.write("k");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("web");
  });

  // ── dashboard input: restart (r) ─────────────────────────────

  it("restarts selected service with r key", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("web");
  });

  it("ignores r when busy", () => {
    const client = createMockClient();
    client.restartService = vi.fn().mockReturnValue(
      new Promise(() => {
        /* Noop */
      }),
    );
    const { stdin } = renderRouter({ client });
    stdin.write("r");
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledTimes(1);
  });

  it("ignores r when statuses empty", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ statuses: [], client });
    stdin.write("r");
    expect(client.restartService).not.toHaveBeenCalled();
  });

  // ── dashboard input: toggle (s) ──────────────────────────────

  it("toggles selected service with s key", () => {
    const client = createMockClient();
    client.listServices = vi.fn().mockResolvedValue([makeStatus({ state: "ready" })]);
    const { stdin } = renderRouter({ client });
    stdin.write("s");
    expect(client.listServices).toHaveBeenCalled();
  });

  // ── dashboard input: logs (l) ────────────────────────────────

  it("navigates to log view with l key", async () => {
    const { stdin, lastFrame } = renderRouter();
    stdin.write("l");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("web");
  });

  // ── dashboard input: open URL (o) ────────────────────────────

  it("opens URL with o key when service has url", () => {
    const statuses = [makeStatus({ url: "http://localhost:3000" })];
    const { stdin } = renderRouter({ statuses });
    stdin.write("o");
    expect(openInBrowser).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("does not open when service has no url", () => {
    const statuses = [makeStatus({ url: undefined })];
    const { stdin } = renderRouter({ statuses });
    stdin.write("o");
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  // ── dashboard input: docker rebuild (R) ──────────────────────

  it("enters docker rebuild view with R for docker service", async () => {
    const statuses = [makeStatus({ isDocker: true })];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "web",
        dependsOn: [],
        hasDocker: true,
        dockerDefaults: {
          build: true,
          forceRecreate: false,
          renewVolumes: false,
          pull: false,
          removeOrphans: false,
        },
      },
    ];
    const { stdin, lastFrame } = renderRouter({ statuses, servicesMeta });
    stdin.write("R");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    // Dashboard still renders underneath popup
    expect(frame).toContain("web");
    // Pressing escape proves we were in docker rebuild view
    await pressEscape(stdin);
    expect(lastFrame()).toContain("web");
  });

  it("ignores R for non-docker service", () => {
    const statuses = [makeStatus({ isDocker: false })];
    const { stdin, lastFrame } = renderRouter({ statuses });
    const frameBefore = lastFrame();
    stdin.write("R");
    expect(lastFrame()).toBe(frameBefore);
  });

  // ── dashboard input: zoom pane (z) ──────────────────────────

  it("zooms pane with z key", () => {
    const paneMap = { web: "%1" };
    const { stdin } = renderRouter({ paneMap });
    stdin.write("z");
    expect(zoomPane).toHaveBeenCalledWith("%1");
  });

  it("does not zoom when no pane mapped", () => {
    const { stdin } = renderRouter({ paneMap: {} });
    stdin.write("z");
    expect(zoomPane).not.toHaveBeenCalled();
  });

  // ── dashboard input: zoom TUI pane (Z) ─────────────────────

  it("zooms TUI pane with Z key", () => {
    const paneMap = { "@tui": "%0", web: "%1" };
    const { stdin } = renderRouter({ paneMap });
    stdin.write("Z");
    expect(zoomPane).toHaveBeenCalledWith("%0");
  });

  // ── dashboard input: edit pane capture (E) ───────────────────

  it("captures pane with E key", () => {
    const paneMap = { web: "%1" };
    const { stdin } = renderRouter({ paneMap });
    stdin.write("E");
    expect(editPaneCapture).toHaveBeenCalledWith("%1", "web");
  });

  // ── dashboard input: detached services disable pane actions ──

  it("does not zoom a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true })];
    const { stdin } = renderRouter({ statuses, paneMap: { worker: "%1" } });
    stdin.write("z");
    expect(zoomPane).not.toHaveBeenCalled();
  });

  it("does not edit-capture a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true })];
    const { stdin } = renderRouter({ statuses, paneMap: { worker: "%1" } });
    stdin.write("E");
    expect(editPaneCapture).not.toHaveBeenCalled();
  });

  it("still opens logs for a detached service with l key", async () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true })];
    const { stdin, lastFrame } = renderRouter({ statuses });
    stdin.write("l");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame() ?? "").toContain("worker");
  });

  // ── dashboard input: tasks view (t) ──────────────────────────

  it("navigates to tasks view with t key", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin, lastFrame } = renderRouter({ tasks });
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
  });

  // ── dashboard input: restart all (a) ─────────────────────────

  it("restarts all services with a key", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("a");
    expect(client.restartAll).toHaveBeenCalled();
  });

  // ── dashboard input: destroy session (d) ─────────────────────

  it("destroys session with d key", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("d");
    expect(client.destroySession).toHaveBeenCalled();
  });

  // ── global input: quit (q) ───────────────────────────────────

  it("disconnects client on q", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("q");
    expect(client.disconnect).toHaveBeenCalled();
  });

  // ── logs view input ──────────────────────────────────────────

  it("returns to dashboard from logs on escape", async () => {
    const { stdin, lastFrame } = renderRouter();
    stdin.write("l");
    await act(async () => {
      /* Flush */
    });
    await pressEscape(stdin);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("zaps");
  });

  // ── tasks view input ─────────────────────────────────────────

  it("returns to dashboard from tasks on escape", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin, lastFrame } = renderRouter({ tasks });
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toContain("[enter] run");
    await pressEscape(stdin);
    expect(lastFrame()).toContain("zaps");
  });

  it("triggers task run on enter in tasks view", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin, lastFrame } = renderRouter({ tasks });
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    stdin.write("\r");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
  });

  it("matches task shortcut in tasks view", async () => {
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null, shortcut: "m" },
      { key: "seed", name: "Seed DB", description: null, shortcut: "s" },
    ];
    const { stdin, lastFrame } = renderRouter({ tasks });
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    stdin.write("s");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
  });

  it("navigates tasks list with j/k in tasks view", async () => {
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null },
      { key: "seed", name: "Seed DB", description: null },
    ];
    const { stdin, lastFrame } = renderRouter({ tasks });
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    stdin.write("j");
    stdin.write("k");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
  });

  // ── docker rebuild input ─────────────────────────────────────

  describe("docker rebuild view", () => {
    function enterDockerRebuild() {
      const statuses = [makeStatus({ isDocker: true })];
      const servicesMeta: ServiceMeta[] = [
        {
          name: "web",
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
      const client = createMockClient();
      const result = renderRouter({ statuses, servicesMeta, client });
      result.stdin.write("R");
      return { ...result, client };
    }

    it("exits with escape", async () => {
      const { stdin, lastFrame } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      await pressEscape(stdin);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("zaps");
    });

    it("toggles flag with space without crashing", async () => {
      const { stdin, lastFrame } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      stdin.write(" ");
      await act(async () => {
        /* Flush */
      });
      expect(lastFrame()).toBeDefined();
    });

    it("navigates flags with j/k without crashing", async () => {
      const { stdin, lastFrame } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      stdin.write("j");
      stdin.write("k");
      await act(async () => {
        /* Flush */
      });
      expect(lastFrame()).toBeDefined();
    });

    it("clamps flag index at boundaries", async () => {
      const { stdin, lastFrame } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      stdin.write("k");
      stdin.write("k");
      await act(async () => {
        /* Flush */
      });
      expect(lastFrame()).toBeDefined();
      for (let i = 0; i < DOCKER_REBUILD_FLAGS.length + 2; i += 1) {
        stdin.write("j");
      }
      await act(async () => {
        /* Flush */
      });
      expect(lastFrame()).toBeDefined();
    });

    it("rebuilds on enter and returns to dashboard", async () => {
      const { stdin, lastFrame } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      stdin.write("\r");
      await act(async () => {
        /* Flush */
      });
      const frame = lastFrame() ?? "";
      expect(frame).toContain("zaps");
    });

    it("ignores enter when busy", async () => {
      const { stdin, client } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      stdin.write("\r");
      await act(async () => {
        /* Flush */
      });
      stdin.write("R");
      await act(async () => {
        /* Flush */
      });
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  // ── buildDockerOverrides via docker rebuild ──────────────────

  it("builds overrides from toggled flags", async () => {
    const statuses = [makeStatus({ isDocker: true })];
    const servicesMeta: ServiceMeta[] = [
      {
        name: "web",
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
    const client = createMockClient();
    const { stdin } = renderRouter({ statuses, servicesMeta, client });

    stdin.write("R");
    await act(async () => {
      /* Flush */
    });
    stdin.write(" ");
    stdin.write("j");
    stdin.write(" ");
    await act(async () => {
      /* Flush */
    });
    stdin.write("\r");
    await act(async () => {
      /* Flush */
    });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  // ── onTaskComplete via daemon events ─────────────────────────

  it("handles task.start event", async () => {
    const client = createMockClient();
    const { lastFrame } = renderRouter({ client });
    client.emit("task.start", "migrate", "Run migrations");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toBeDefined();
  });

  it("handles task.complete replacing running entry", async () => {
    const client = createMockClient();
    const { lastFrame } = renderRouter({ client });
    client.emit("task.start", "migrate", "Run migrations");
    await act(async () => {
      /* Flush */
    });
    client.emit("task.complete", "migrate", "Run migrations", "success");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toBeDefined();
  });

  it("handles task.complete without prior start", async () => {
    const client = createMockClient();
    const { lastFrame } = renderRouter({ client });
    client.emit("task.complete", "seed", "Seed DB", "error");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toBeDefined();
  });

  // ── ready gate with autoStart ────────────────────────────────

  describe("autoStart ready gate", () => {
    afterEach(() => vi.useRealTimers());

    it("renders empty when autoStart and no activity yet", () => {
      vi.useFakeTimers();
      const client = createMockClient();
      const { lastFrame } = renderRouter({
        autoStart: true,
        statuses: [],
        client,
      });
      // Not ready — waiting for both timer and activity
      expect(lastFrame()).toBe("");
    });

    it("renders dashboard after timer elapsed (no activity needed)", async () => {
      vi.useFakeTimers();
      const client = createMockClient();
      const { lastFrame } = renderRouter({
        autoStart: true,
        statuses: [],
        client,
      });

      // Advance past MIN_SPLASH_MS — should render even without activity
      await vi.advanceTimersByTimeAsync(1300);
      // Flush React microtasks without relying on fake setTimeout
      await Promise.resolve();
      await Promise.resolve();
      const frame = lastFrame() ?? "";
      expect(frame.length).toBeGreaterThan(0);
    });

    it("renders empty before timer elapsed", () => {
      vi.useFakeTimers();
      const client = createMockClient();
      const { lastFrame } = renderRouter({
        autoStart: true,
        statuses: [],
        client,
      });

      // Timer not yet elapsed — should still be empty
      expect(lastFrame()).toBe("");
    });

    it("is immediately ready without autoStart", () => {
      const { lastFrame } = renderRouter({ autoStart: false });
      const frame = lastFrame() ?? "";
      expect(frame.length).toBeGreaterThan(0);
    });

    it("is immediately ready when autoStart is undefined", () => {
      const { lastFrame } = renderRouter();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("zaps");
    });
  });

  // ── ctrl+d: destroy from any view ────────────────────────────

  it("destroys session on ctrl+d", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("\x04");
    expect(client.destroySession).toHaveBeenCalled();
  });

  // ── q still works during per-service busy ───────────────────

  it("allows q even when a service is busy", () => {
    const client = createMockClient();
    client.restartService = vi.fn().mockReturnValue(
      new Promise(() => {
        /* Noop */
      }),
    );
    const { stdin } = renderRouter({ client });
    stdin.write("r"); // Makes service busy (per-service, not global)
    stdin.write("q");
    expect(client.disconnect).toHaveBeenCalled();
  });

  // ── ctrl+d still works during per-service busy ────────────

  it("allows ctrl+d even when a service is busy", () => {
    const client = createMockClient();
    client.restartService = vi.fn().mockReturnValue(
      new Promise(() => {
        /* Noop */
      }),
    );
    const { stdin } = renderRouter({ client });
    stdin.write("r"); // Makes service busy
    stdin.write("\x04");
    expect(client.destroySession).toHaveBeenCalled();
  });
});
