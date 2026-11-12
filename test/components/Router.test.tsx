import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DaemonClient,
  DaemonRequestError,
  TerminalActionError,
} from "../../src/client/daemon-client.js";
import { OverlayHost } from "../../src/components/overlay/OverlayHost.js";
import { START_SERVICES_ID } from "../../src/components/overlay/StartServicesOverlay.js";
import { TASK_PICKER_ID } from "../../src/components/overlay/TaskPicker.js";
import { Router } from "../../src/components/Router.js";
import { ShellProviders } from "../../src/components/ShellProviders.js";
import type { TaskRunRecord } from "../../src/components/TaskRunRecord.js";
import { resolveUiConfig } from "../../src/config/index.js";
import type { ResolvedUiConfig } from "../../src/config/index.js";
import type { ProjectedServiceStatus, ServiceMeta, TaskInfo } from "../../src/daemon/session.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { useOverlay } from "../../src/hooks/useOverlay.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { TerminalActionResult } from "../../src/lib/backend/schemas.js";
import type { BackendCapabilities } from "../../src/lib/backend/types.js";
import {
  parseServiceStatus,
  unavailableActions,
  unavailableCapabilities,
} from "../../src/lib/backend/wire.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { deferred } from "../_helpers/deferred.js";
import { makeSessionSnapshot } from "../_helpers/session-snapshot.js";
import { fullCapabilities, liveActions, mixedCapabilities } from "../_helpers/ui-capabilities.js";

// ── mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/lib/open.js", () => ({
  openInBrowser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/tmux.js", () => ({
  detachClient: vi.fn().mockResolvedValue(undefined),
}));

const exit = vi.hoisted(() => vi.fn());
vi.mock(import("ink"), async (importOriginal) => {
  const ink = await importOriginal();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit }) };
});

const { openInBrowser } = await import("../../src/lib/open.js");
const { detachClient } = await import("../../src/lib/tmux.js");

const zoomWeb = { action: "zoom", target: { kind: "service", name: "web" } };
const zoomDashboard = { action: "zoom", target: { kind: "dashboard" } };
const editWeb = { action: "editOutput", service: "web" };
const NO_START = { start: undefined };
const popupTask = { key: "migrate", name: "Run migrations", description: null };

// ── helpers ────────────────────────────────────────────────────────────

function createMockClient(): DaemonClient {
  const client = new DaemonClient("/unused", "test");
  vi.spyOn(client, "uiBound", "get").mockReturnValue(true);
  vi.spyOn(client, "connected", "get").mockReturnValue(true);
  return Object.assign(client, {
    connect: vi.fn(),
    connectUi: vi.fn(),
    terminalAction: vi.fn<DaemonClient["terminalAction"]>(async ({ action }) =>
      action === "taskPicker" ? { action, taskKey: null } : { action, done: true },
    ),
    disconnect: vi.fn(),
    detach: vi.fn<DaemonClient["detach"]>().mockResolvedValue(undefined),
    deliverUpgradeNotice: vi.fn(),
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
    runTaskInPane: vi.fn().mockResolvedValue({ runId: "run_1", paneId: "%9" }),
    preflightTask: vi.fn<DaemonClient["preflightTask"]>(async (key) => ({
      key,
      services: [],
      needsStart: false,
      autoStart: false,
      blocked: [],
    })),
    getTaskOutput: vi.fn(async (runId: string) => ({
      runId,
      taskKey: "build",
      result: "error",
      lines: ["failed"],
      startedAt: 0,
    })),
    rebuildDocker: vi.fn().mockResolvedValue(undefined),
  });
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

// Captures the live overlay API so tests can assert the stack (the palette,
// Help, and docker-rebuild overlays render position="absolute" and are not
// Capturable by ink-testing-library, so frame text isn't reliable for them).
let overlay: OverlayApi | undefined;

function OverlayController() {
  overlay = useOverlay();
  return null;
}

function renderRouter(
  opts: {
    statuses?: (ServiceStatus & { actions?: ProjectedServiceStatus["actions"] })[];
    capabilities?: BackendCapabilities;
    backend?: "shell" | "tmux";
    tasks?: TaskInfo[];
    servicesMeta?: ServiceMeta[];
    paneMap?: Record<string, string>;
    taskHistory?: TaskRunRecord[];
    autoStart?: boolean;
    client?: DaemonClient;
    ui?: ResolvedUiConfig;
  } = {},
) {
  const client = opts.client ?? createMockClient();
  const statuses = opts.statuses ?? [makeStatus()];
  const tasks = opts.tasks ?? [];
  const paneMap = opts.paneMap ?? {};
  const servicesMeta = opts.servicesMeta ?? [];
  const taskHistory = opts.taskHistory ?? [];

  const result = render(
    <ShellProviders>
      <AppProvider
        client={client}
        paneMap={paneMap}
        projectName="test-project"
        tasks={tasks}
        servicesMeta={servicesMeta}
        statuses={statuses.map((status) => parseServiceStatus(status))}
        backend={opts.backend}
        capabilities={opts.capabilities}
        ui={opts.ui ?? resolveUiConfig({ notifications: "off" })}
      >
        <OverlayController />
        <Router initialTaskHistory={taskHistory} autoStart={opts.autoStart} />
        <OverlayHost />
      </AppProvider>
    </ShellProviders>,
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

// Send a key inside act + settle. The mock stdin can drop the first keystroke
// Aimed at a just-pushed overlay's `useInput`, so callers warm up with an
// Ignored key first.
async function pressKey(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
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
    vi.unstubAllEnvs();
    overlay = undefined;
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

  it("opens the docker-rebuild overlay with R for a docker service", async () => {
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
    const { stdin } = renderRouter({ statuses, servicesMeta });
    stdin.write("R");
    await act(async () => {
      /* Flush */
    });
    expect(overlay?.top?.id).toBe("docker-rebuild");
    // Esc is owned by OverlayHost (overlay binds no Esc) → closes it.
    await pressEscape(stdin);
    expect(overlay?.isOpen).toBe(false);
  });

  it("ignores R for non-docker service", () => {
    const statuses = [makeStatus({ isDocker: false })];
    const { stdin } = renderRouter({ statuses });
    stdin.write("R");
    expect(overlay?.isOpen).toBe(false);
  });

  // ── dashboard input: zoom pane (z) ──────────────────────────

  it("zooms the configured service with z even if the pane map differs", () => {
    const paneMap = { web: "%2" };
    const { stdin, client } = renderRouter({
      paneMap,
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus({ paneId: "%1" }), actions: liveActions }],
    });
    stdin.write("z");
    expect(client.terminalAction).toHaveBeenCalledWith(zoomWeb);
  });

  it("does not zoom without a live service action", () => {
    const { stdin, client } = renderRouter({
      paneMap: {},
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus(), actions: unavailableActions }],
    });
    stdin.write("z");
    expect(client.terminalAction).not.toHaveBeenCalled();
  });

  // ── dashboard input: zoom TUI pane (Z) ─────────────────────

  it("zooms the dashboard with Z without a pane address", () => {
    const { stdin, client } = renderRouter({
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus(), actions: liveActions }],
    });
    stdin.write("Z");
    expect(client.terminalAction).toHaveBeenCalledWith(zoomDashboard);
  });

  // ── dashboard input: edit pane capture (E) ───────────────────

  it("captures pane with E key", () => {
    const paneMap = { web: "%1" };
    const { stdin, client } = renderRouter({
      paneMap,
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus({ paneId: "%1" }), actions: liveActions }],
    });
    stdin.write("E");
    expect(client.terminalAction).toHaveBeenCalledWith(editWeb);
  });

  it("updates service hints immediately while edit capture is pending", async () => {
    const edit = deferred<TerminalActionResult>();
    const status = { ...makeStatus({ paneId: "%1", isDocker: true }), actions: liveActions };
    const mockClient = createMockClient();
    vi.mocked(mockClient.listServices).mockResolvedValue([parseServiceStatus(status)]);
    const { client, stdin, lastFrame } = renderRouter({
      client: mockClient,
      capabilities: { ...fullCapabilities, zoom: false },
      statuses: [status],
    });
    vi.mocked(client.terminalAction).mockReturnValueOnce(edit.promise);
    const busyHints = ["[E]dit", "[r]estart", "[R]ebuild"];
    for (const hint of busyHints) {
      expect(lastFrame()).toContain(hint);
    }
    act(() => {
      stdin.write("E");
      stdin.write("E");
      stdin.write("r");
      stdin.write("a");
    });
    expect(client.restartAll).not.toHaveBeenCalled();
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(editWeb);
    expect(client.restartService).not.toHaveBeenCalled();
    for (const hint of busyHints) {
      expect(lastFrame()).not.toContain(hint);
    }
    expect(lastFrame()).toContain("[l]ogs");

    await act(async () => {
      edit.resolve({ action: "editOutput", done: true });
    });
    for (const hint of busyHints) {
      expect(lastFrame()).toContain(hint);
    }
  });

  // ── dashboard input: detached services disable pane actions ──

  it("does not zoom a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true, paneId: "%1" })];
    const { stdin, client } = renderRouter({
      statuses,
      capabilities: fullCapabilities,
      paneMap: { worker: "%1" },
    });
    stdin.write("z");
    expect(client.terminalAction).not.toHaveBeenCalled();
  });

  it("does not edit-capture a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true, paneId: "%1" })];
    const { stdin, client } = renderRouter({
      statuses,
      capabilities: fullCapabilities,
      paneMap: { worker: "%1" },
    });
    stdin.write("E");
    expect(client.terminalAction).not.toHaveBeenCalled();
  });

  it("still opens logs for a detached service with l key", async () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true, paneId: "%1" })];
    const { stdin, lastFrame } = renderRouter({ statuses });
    stdin.write("l");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame() ?? "").toContain("worker");
  });

  it.each([
    ["shell", unavailableCapabilities],
    ["tmux", mixedCapabilities],
  ] as const)(
    "suppresses pane hotkeys and popup requests with %s capabilities",
    async (backend, capabilities) => {
      const { stdin, client } = renderRouter({
        backend,
        capabilities,
        statuses: [
          { ...makeStatus({ url: "http://localhost:3000", paneId: "%1" }), actions: liveActions },
        ],
        paneMap: { web: "%1", "@tui": "%0" },
        tasks: [{ key: "build", name: "Build", description: null }],
        ui: resolveUiConfig({
          notifications: "off",
          failOutput: "popup",
          task: { popupPicker: true, defaultMode: "pane" },
        }),
      });
      stdin.write("z");
      stdin.write("Z");
      stdin.write("E");
      stdin.write("o");
      stdin.write("r");
      expect(client.terminalAction).not.toHaveBeenCalled();
      expect(openInBrowser).toHaveBeenCalledWith("http://localhost:3000");
      expect(client.restartService).toHaveBeenCalledWith("web");

      await pressKey(stdin, "t");
      expect(client.terminalAction).not.toHaveBeenCalled();
      expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
      await pressKey(stdin, "\t");
      await pressKey(stdin, "\t");
      if (capabilities.taskPanes) {
        expect(client.runTaskInPane).toHaveBeenCalledExactlyOnceWith("build", undefined, NO_START);
      } else {
        expect(client.runTaskInPane).not.toHaveBeenCalled();
        expect(client.runTask).not.toHaveBeenCalled();
        expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
        await pressKey(stdin, "\r");
        expect(client.runTask).toHaveBeenCalledExactlyOnceWith("build", {}, NO_START);
      }
      expect(overlay?.isOpen).toBe(false);

      act(() => {
        client.emit("task.complete", "build", "Build", "error", "failed-run");
      });
      await pressKey(stdin, "f");
      expect(overlay?.top?.id).toBe("failed-output");
      await pressKey(stdin, "p");
      expect(client.terminalAction).not.toHaveBeenCalled();
      expect(client.getTaskOutput).toHaveBeenCalledWith("failed-run");
    },
  );

  it("refreshes service hotkeys when a stopped pane disappears", async () => {
    const stopped = { ...makeStatus({ state: "stopped", paneId: "%1" }), actions: liveActions };
    const { stdin, client } = renderRouter({
      capabilities: fullCapabilities,
      statuses: [stopped],
      paneMap: { web: "%1", "@tui": "%0" },
    });
    stdin.write("z");
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(zoomWeb);
    act(() => {
      client.emit("service.stateChange", "web", { ...stopped, actions: unavailableActions });
    });
    await pressKey(stdin, "z");
    await pressKey(stdin, "E");
    await pressKey(stdin, "Z");
    expect(vi.mocked(client.terminalAction).mock.calls).toEqual([[zoomWeb], [zoomDashboard]]);
  });

  it.each([
    ["zoom", zoomWeb],
    ["edit", editWeb],
  ] as const)("guards a stale palette %s command after pane removal", async (query, action) => {
    const stopped = { ...makeStatus({ state: "stopped", paneId: "%1" }), actions: liveActions };
    const { stdin, client } = renderRouter({
      capabilities: fullCapabilities,
      statuses: [stopped],
      paneMap: { web: "%1" },
    });
    await pressKey(stdin, ":");
    expect(overlay?.top?.id).toBe("command-palette");
    await pressKey(stdin, query);
    await pressKey(stdin, "\r");
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
    expect(overlay?.isOpen).toBe(false);
    await pressKey(stdin, ":");
    expect(overlay?.top?.id).toBe("command-palette");
    await pressKey(stdin, query);
    act(() => {
      client.emit("service.stateChange", "web", { ...stopped, actions: unavailableActions });
    });
    await pressKey(stdin, "\r");
    expect(overlay?.isOpen).toBe(false);
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("updates an open task picker when pane runs become unavailable", async () => {
    const tasks = [{ key: "build", name: "Build", description: null }];
    const ui = { task: { defaultMode: "pane" } } satisfies Parameters<typeof resolveUiConfig>[0];
    const { stdin, client } = renderRouter({
      tasks,
      capabilities: mixedCapabilities,
      ui: resolveUiConfig(ui),
    });
    await pressKey(stdin, "t");
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
    act(() => {
      client.emit("session.configReloaded", makeSessionSnapshot({ tasks, ui }));
    });
    await pressKey(stdin, "\t");
    await pressKey(stdin, "\t");
    expect(client.runTaskInPane).not.toHaveBeenCalled();
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
    await pressKey(stdin, "\r");
    expect(client.runTask).toHaveBeenCalledExactlyOnceWith("build", {}, NO_START);
    expect(overlay?.isOpen).toBe(false);
  });

  it("checks live popup capability before launching a returned selection", async () => {
    const picker = deferred<TerminalActionResult>();
    const tasks = [{ key: "build", name: "Build", description: null }];
    const ui = { task: { popupPicker: true } };
    const { stdin, client } = renderRouter({
      tasks,
      capabilities: fullCapabilities,
      ui: resolveUiConfig(ui),
    });
    vi.mocked(client.terminalAction).mockReturnValueOnce(picker.promise);
    await pressKey(stdin, "t");
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith({ action: "taskPicker" });
    act(() => {
      client.emit("session.configReloaded", makeSessionSnapshot({ tasks, ui }));
    });
    await act(async () => {
      picker.resolve({ action: "taskPicker", taskKey: "build" });
    });
    expect(client.runTask).not.toHaveBeenCalled();
    expect(overlay?.isOpen).toBe(false);
  });

  it("disables escalation in an open output overlay after a capability refresh", async () => {
    const { stdin, client } = renderRouter({ capabilities: fullCapabilities });
    act(() => {
      client.emit("task.complete", "build", "Build", "error", "failed-run");
    });
    await pressKey(stdin, "f");
    expect(overlay?.top?.id).toBe("failed-output");
    expect(client.terminalAction).not.toHaveBeenCalled();
    await pressKey(stdin, "p");
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith({
      action: "taskOutput",
      runId: "failed-run",
    });
    act(() => {
      client.emit("session.configReloaded", makeSessionSnapshot());
    });
    await pressKey(stdin, "p");
    expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith({
      action: "taskOutput",
      runId: "failed-run",
    });
    expect(overlay?.top?.id).toBe("failed-output");
    expect(client.getTaskOutput).toHaveBeenCalledOnce();
  });

  // ── dashboard input: task picker (t) ─────────────────────────

  it("opens the task picker overlay with t key", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({ tasks });
    await pressKey(stdin, "t");
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
  });

  // ── dashboard input: restart all (a) ─────────────────────────

  it("restarts all services with a key", () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("a");
    expect(client.restartAll).toHaveBeenCalled();
  });

  // ── dashboard input: destroy session (d) ─────────────────────

  it("asks before destroying the session on `d`", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("d");
    await act(async () => {
      /* Flush */
    });
    // Nothing torn down yet — `d` only opens the confirmation overlay.
    expect(client.destroySession).not.toHaveBeenCalled();
    expect(overlay?.top?.id).toBe("shutdown-confirm");
  });

  // ── single sort, shared by render + input handler (F8) ───────

  it("targets the highlighted row even when arrival order differs from sorted order (F8)", () => {
    // Daemon delivers the unavailable service FIRST; the dashboard sorts it to the
    // Bottom, so the highlighted row (index 0) is the ready service. The input
    // Handler must index that same sorted array — restart hits "api", not "zoo".
    const client = createMockClient();
    const statuses = [
      makeStatus({ name: "zoo", state: "unavailable" }),
      makeStatus({ name: "api", state: "ready" }),
    ];
    const { stdin } = renderRouter({ statuses, client });
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("api");
    expect(client.restartService).not.toHaveBeenCalledWith("zoo");
  });

  // ── per-view selection (F6) ──────────────────────────────────

  it("keeps dashboard and tasks selection independent across a view round-trip (F6)", async () => {
    const client = createMockClient();
    const statuses = [
      makeStatus({ name: "web", state: "ready" }),
      makeStatus({ name: "api", state: "ready" }),
      makeStatus({ name: "db", state: "ready" }),
    ];
    const tasks: TaskInfo[] = [
      { key: "migrate", name: "Run migrations", description: null },
      { key: "seed", name: "Seed DB", description: null },
    ];
    const { stdin } = renderRouter({ statuses, tasks, client });

    // Move dashboard selection to the third service (db).
    stdin.write("j");
    stdin.write("j");
    await act(async () => {
      /* Flush */
    });

    // Enter tasks view and move its (separate) selection.
    stdin.write("t");
    await act(async () => {
      /* Flush */
    });
    stdin.write("j");
    await act(async () => {
      /* Flush */
    });

    // Back to the dashboard — its selection must be untouched, so r hits db.
    await pressEscape(stdin);
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("db");
  });

  // ── global input: quit (q) ───────────────────────────────────

  it.each(["q", "\x03", "palette"])(
    "waits for bound detach before exiting via %j",
    async (input) => {
      const { stdin, client } = renderRouter();
      const ack = deferred<void>();
      vi.mocked(client.detach).mockReturnValueOnce(ack.promise);
      if (input === "palette") {
        await pressKey(stdin, ":");
        await pressKey(stdin, "detach");
        await pressKey(stdin, "\r");
      } else {
        await pressKey(stdin, input);
      }
      expect(client.detach).toHaveBeenCalledExactlyOnceWith({ detachHost: true });
      expect(exit).not.toHaveBeenCalled();
      await pressKey(stdin, "q");
      await pressKey(stdin, "\x03");
      expect(client.detach).toHaveBeenCalledOnce();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.destroySession).not.toHaveBeenCalled();
      await act(async () => {
        ack.resolve();
      });
      expect(exit).toHaveBeenCalledOnce();
    },
  );

  it("quits shell even with inherited managed tmux environment", async () => {
    vi.stubEnv("ZAPS_MANAGED_TMUX", "1");
    vi.stubEnv("TMUX", "/tmp/tmux-1000/zaps,42,0");
    const { stdin, client } = renderRouter({ backend: "shell" });
    await pressKey(stdin, "q");
    expect(detachClient).not.toHaveBeenCalled();
    expect(client.detach).toHaveBeenCalledExactlyOnceWith({ detachHost: true });
    expect(client.destroySession).not.toHaveBeenCalled();
    expect(client.stopService).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it.each([
    ["ambiguous host", "backend_unavailable"],
    ["legacy daemon", "Restart the daemon to upgrade."],
    ["invalid acknowledgement", "Invalid detach response"],
  ])("keeps the log view active after %s and allows another quit", async (_case, detail) => {
    const { stdin, client, lastFrame } = renderRouter();
    vi.mocked(client.detach).mockRejectedValueOnce(
      new DaemonRequestError(detail, "backend_unavailable"),
    );
    await pressKey(stdin, "l");
    await pressKey(stdin, "q");
    expect(lastFrame()).toContain(detail);
    expect(lastFrame()).toContain("Detach tmux manually");
    expect(lastFrame()).toContain("[esc] back");
    expect(exit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    await pressKey(stdin, "q");
    expect(client.detach).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "routes offline quit using verified host metadata (%s)",
    async (canQuitOffline) => {
      const client = createMockClient();
      vi.spyOn(client, "canQuitOffline", "get").mockReturnValue(canQuitOffline);
      const { stdin, lastFrame } = renderRouter({ client });
      act(() => {
        vi.mocked(client.connectUi).mockResolvedValue(makeSessionSnapshot());
        vi.spyOn(client, "uiBound", "get").mockReturnValue(false);
        client.emit("disconnect");
      });
      expect(lastFrame()).toContain(canQuitOffline ? "q quit" : "Detach tmux manually");
      expect(lastFrame()).not.toContain("[q]uit/detach");
      await pressKey(stdin, "q");
      expect(client.detach).not.toHaveBeenCalled();
      expect(detachClient).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(canQuitOffline ? 1 : 0);
      expect(exit).toHaveBeenCalledTimes(canQuitOffline ? 1 : 0);
      if (!canQuitOffline) {
        await pressKey(stdin, "r");
        expect(client.connectUi).toHaveBeenCalledOnce();
      }
    },
  );

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

  // ── task picker overlay (Router integration) ─────────────────
  // Detailed filter/highlight/empty/guard behavior lives in the dedicated
  // TaskPicker test; here we assert the Router wiring only (open/close/run).

  it("closes the task picker on escape (host owns Esc)", async () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({ tasks });
    await pressKey(stdin, "t");
    expect(overlay?.isOpen).toBe(true);
    await pressKey(stdin, "x"); // Warm-up (ignored by the just-pushed overlay)
    await pressEscape(stdin);
    expect(overlay?.isOpen).toBe(false);
  });

  it("runs the selected task in the background on enter", async () => {
    const client = createMockClient();
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({ tasks, client });
    await pressKey(stdin, "t");
    // Double Enter: the first may be dropped by the just-pushed overlay; the
    // Second lands. Whichever runs, the task fires once and the overlay closes.
    await pressKey(stdin, "\r");
    await pressKey(stdin, "\r");
    expect(client.runTask).toHaveBeenCalledWith("migrate", {}, NO_START);
    expect(overlay?.isOpen).toBe(false);
  });

  describe("start-services launch flow", () => {
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const downArrow = "\u001B[B";

    function preflight(
      overrides: Partial<Awaited<ReturnType<DaemonClient["preflightTask"]>>> = {},
    ): Awaited<ReturnType<DaemonClient["preflightTask"]>> {
      return {
        key: "migrate",
        services: [
          { name: "db", state: "stopped", action: "start", required: false, startable: true },
          { name: "api", state: "stopped", action: "start", required: true, startable: true },
        ],
        needsStart: true,
        autoStart: false,
        blocked: [],
        ...overrides,
      };
    }

    async function launchFromPicker(stdin: { write: (data: string) => void }) {
      await pressKey(stdin, "t");
      await pressKey(stdin, downArrow);
      await pressKey(stdin, "\r");
    }

    async function launchFromPalette(stdin: { write: (data: string) => void }) {
      await pressKey(stdin, ":");
      await pressKey(stdin, "Run task");
      await pressKey(stdin, "\r");
    }

    it("launches immediately when nothing needs to start", async () => {
      const { stdin, client } = renderRouter({ tasks });
      await launchFromPicker(stdin);
      expect(client.preflightTask).toHaveBeenCalledExactlyOnceWith("migrate");
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, NO_START);
      expect(overlay?.isOpen).toBe(false);
    });

    it("falls back to a plain launch when preflight fails", async () => {
      const { stdin, client } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockRejectedValueOnce(new Error("Unknown method"));
      await launchFromPicker(stdin);
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, NO_START);
    });

    it("starts services without a prompt when the task has autoStart", async () => {
      const { stdin, client } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(preflight({ autoStart: true }));
      await launchFromPicker(stdin);
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, { start: true });
      expect(overlay?.isOpen).toBe(false);
    });

    it("passes start to pane launches", async () => {
      const { stdin, client } = renderRouter({
        tasks,
        capabilities: fullCapabilities,
        ui: resolveUiConfig({ notifications: "off", task: { defaultMode: "pane" } }),
      });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(preflight({ autoStart: true }));
      await launchFromPicker(stdin);
      expect(client.runTaskInPane).toHaveBeenCalledExactlyOnceWith("migrate", undefined, {
        start: true,
      });
    });

    it.each(["y", "\r"])("asks before starting services and launches on %j", async (key) => {
      const { stdin, client } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(preflight());
      await launchFromPicker(stdin);
      expect(overlay?.top?.id).toBe(START_SERVICES_ID);
      expect(client.runTask).not.toHaveBeenCalled();
      await pressKey(stdin, "j");
      expect(overlay?.top?.id).toBe(START_SERVICES_ID);
      await pressKey(stdin, key);
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, { start: true });
      expect(overlay?.isOpen).toBe(false);
    });

    it.each(["n", "escape"])("cancels the prompt on %s without launching", async (key) => {
      const { stdin, client } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(preflight());
      await launchFromPicker(stdin);
      expect(overlay?.top?.id).toBe(START_SERVICES_ID);
      await pressKey(stdin, "j");
      await (key === "escape" ? pressEscape(stdin) : pressKey(stdin, key));
      expect(overlay?.isOpen).toBe(false);
      expect(client.runTask).not.toHaveBeenCalled();
    });

    it("shows an error toast and launches nothing when a service is unavailable", async () => {
      const { stdin, client, lastFrame } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(
        preflight({ blocked: ["gpu"], needsStart: false }),
      );
      await launchFromPicker(stdin);
      expect(client.runTask).not.toHaveBeenCalled();
      expect(overlay?.isOpen).toBe(false);
      expect(lastFrame()).toContain("Task Run migrations: service gpu is unavailable");
    });

    it("shows the daemon message when the launch is rejected", async () => {
      const { stdin, client, lastFrame } = renderRouter({ tasks });
      vi.mocked(client.runTask).mockRejectedValueOnce(
        new DaemonRequestError('Service "db" failed to start: boom', "service_start_failed"),
      );
      await launchFromPicker(stdin);
      expect(lastFrame()).toContain('Service "db" failed to start: boom');
    });

    it("toasts while a task waits for services", () => {
      const { client, lastFrame } = renderRouter({ tasks });
      act(() => {
        client.emit("task.preparing", "migrate", ["db", "api"]);
      });
      expect(lastFrame()).toContain("Task Run migrations: waiting for db, api");
    });

    it("clears the shortcut running guard when the prompt is cancelled", async () => {
      const { stdin, client } = renderRouter({ tasks });
      vi.mocked(client.preflightTask).mockResolvedValueOnce(preflight());
      await launchFromPalette(stdin);
      expect(overlay?.top?.id).toBe(START_SERVICES_ID);
      await pressKey(stdin, "j");
      await pressKey(stdin, "n");
      expect(overlay?.isOpen).toBe(false);
      await launchFromPalette(stdin);
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, NO_START);
    });

    it("cancels a prompt replaced by another prompt", async () => {
      const first = deferred<Awaited<ReturnType<DaemonClient["preflightTask"]>>>();
      const second = deferred<Awaited<ReturnType<DaemonClient["preflightTask"]>>>();
      const { stdin, client } = renderRouter({
        tasks: [...tasks, { key: "seed", name: "Seed", description: null }],
      });
      vi.mocked(client.preflightTask)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      await pressKey(stdin, ":");
      await pressKey(stdin, "migrations");
      await pressKey(stdin, "\r");
      await pressKey(stdin, "t");
      await pressKey(stdin, "seed");
      await pressKey(stdin, "\r");
      expect(vi.mocked(client.preflightTask).mock.calls).toEqual([["migrate"], ["seed"]]);
      await act(async () => {
        first.resolve(preflight());
      });
      expect(overlay?.top?.id).toBe(START_SERVICES_ID);
      await act(async () => {
        second.resolve(preflight({ key: "seed" }));
      });
      await pressKey(stdin, "j");
      await pressKey(stdin, "n");
      expect(overlay?.isOpen).toBe(false);
      await launchFromPalette(stdin);
      expect(client.preflightTask).toHaveBeenCalledTimes(3);
    });

    it("clears the shortcut running guard when the launch is rejected", async () => {
      const { stdin, client, lastFrame } = renderRouter({ tasks });
      vi.mocked(client.runTask).mockRejectedValueOnce(
        new DaemonRequestError("needs services", "services_not_running"),
      );
      await launchFromPalette(stdin);
      expect(lastFrame()).toContain("needs services");
      await launchFromPalette(stdin);
      expect(client.runTask).toHaveBeenCalledTimes(2);
    });
  });

  describe("popup picker", () => {
    function openPopupPicker() {
      return renderRouter({
        tasks: [popupTask],
        capabilities: fullCapabilities,
        ui: resolveUiConfig({ task: { popupPicker: true, defaultMode: "pane" } }),
      });
    }

    it("waits for the popup selection and launches it once in the background", async () => {
      const picker = deferred<TerminalActionResult>();
      const { stdin, client } = openPopupPicker();
      vi.mocked(client.terminalAction).mockReturnValueOnce(picker.promise);
      await pressKey(stdin, "t");
      await pressKey(stdin, "t");
      expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith({ action: "taskPicker" });
      expect(client.runTask).not.toHaveBeenCalled();
      expect(overlay?.isOpen).toBe(false);
      await act(async () => {
        picker.resolve({ action: "taskPicker", taskKey: "migrate" });
      });
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, NO_START);
      expect(client.runTaskInPane).not.toHaveBeenCalled();
      expect(overlay?.isOpen).toBe(false);
    });

    it("cancels without starting a task or opening the in-app picker", async () => {
      const { stdin, client } = openPopupPicker();
      await pressKey(stdin, "t");
      expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith({ action: "taskPicker" });
      expect(client.runTask).not.toHaveBeenCalled();
      expect(overlay?.isOpen).toBe(false);
    });

    it("opens one in-app picker after backend_unavailable", async () => {
      const { stdin, client } = openPopupPicker();
      vi.mocked(client.terminalAction).mockRejectedValueOnce(
        new TerminalActionError("fzf unavailable", "backend_unavailable"),
      );
      await pressKey(stdin, "t");
      expect(overlay?.stack.map(({ id }) => id)).toEqual([TASK_PICKER_ID]);
      expect(client.runTask).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: "terminal_busy",
        reason: new TerminalActionError("popup occupied", "terminal_busy"),
      },
      { label: "an untyped failure", reason: new Error("backend_unavailable") },
    ])("leaves the dashboard in place after $label", async ({ reason }) => {
      const { stdin, client } = openPopupPicker();
      vi.mocked(client.terminalAction).mockRejectedValueOnce(reason);
      await pressKey(stdin, "t");
      expect(client.runTask).not.toHaveBeenCalled();
      expect(overlay?.isOpen).toBe(false);
    });

    it.each(["selection", "unavailable"])(
      "discards stale %s after disconnect and reattach",
      async (outcome) => {
        const picker = deferred<TerminalActionResult>();
        const { stdin, client, lastFrame } = openPopupPicker();
        vi.mocked(client.terminalAction).mockReturnValueOnce(picker.promise);
        vi.mocked(client.connectUi).mockResolvedValue(makeSessionSnapshot());
        await pressKey(stdin, "t");
        act(() => {
          client.emit("disconnect");
        });
        expect(lastFrame()).toContain("Daemon connection lost");
        await pressKey(stdin, "r");
        expect(client.connectUi).toHaveBeenCalledOnce();
        await act(async () => {
          if (outcome === "selection") {
            picker.resolve({ action: "taskPicker", taskKey: "migrate" });
          } else {
            picker.reject(new TerminalActionError("fzf unavailable", "backend_unavailable"));
          }
        });
        expect(client.runTask).not.toHaveBeenCalled();
        expect(overlay?.isOpen).toBe(false);
        expect(lastFrame()).not.toContain("Daemon connection lost");
      },
    );

    it("discards an old selection after a newer picker attempt opens", async () => {
      const first = deferred<TerminalActionResult>();
      const second = deferred<TerminalActionResult>();
      const { stdin, client } = openPopupPicker();
      vi.mocked(client.terminalAction)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      await pressKey(stdin, "t");
      await pressKey(stdin, "?");
      expect(overlay?.top?.id).toBe("help");
      await pressEscape(stdin);
      await pressKey(stdin, "t");
      await act(async () => {
        first.resolve({ action: "taskPicker", taskKey: "migrate" });
      });
      expect(client.runTask).not.toHaveBeenCalled();
      await act(async () => {
        second.resolve({ action: "taskPicker", taskKey: "migrate" });
      });
      expect(client.runTask).toHaveBeenCalledExactlyOnceWith("migrate", {}, NO_START);
    });

    it("discards a popup selection after its Router unmounts", async () => {
      const picker = deferred<TerminalActionResult>();
      const { stdin, client, unmount } = openPopupPicker();
      vi.mocked(client.terminalAction).mockReturnValueOnce(picker.promise);
      await pressKey(stdin, "t");
      act(unmount);
      await act(async () => {
        picker.resolve({ action: "taskPicker", taskKey: "migrate" });
      });
      expect(client.runTask).not.toHaveBeenCalled();
    });
  });

  // ── docker rebuild overlay (Router integration) ──────────────
  // Detailed flag-toggle / move / clamp behavior lives in the dedicated
  // DockerRebuildOverlay test (the overlay is position="absolute" and
  // Uncapturable), so here we assert the Router wiring only.

  describe("docker rebuild overlay", () => {
    function dockerMeta(group?: string): ServiceMeta[] {
      return [
        {
          name: "web",
          dependsOn: [],
          hasDocker: true,
          group,
          dockerDefaults: {
            build: false,
            forceRecreate: false,
            renewVolumes: false,
            pull: false,
            removeOrphans: false,
          },
        },
      ];
    }

    function enterDockerRebuild() {
      const client = createMockClient();
      const result = renderRouter({
        statuses: [makeStatus({ isDocker: true })],
        servicesMeta: dockerMeta(),
        client,
      });
      result.stdin.write("R");
      return { ...result, client };
    }

    it("cancels on Esc without rebuilding (host owns Esc)", async () => {
      const { stdin, client } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      await pressKey(stdin, "x"); // Warm-up (ignored)
      await pressEscape(stdin);
      expect(overlay?.isOpen).toBe(false);
      expect(client.rebuildDocker).not.toHaveBeenCalled();
    });

    it("rebuilds on Enter and closes", async () => {
      const { stdin, client } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      await pressKey(stdin, "x"); // Warm-up (ignored)
      await pressKey(stdin, "\r");
      expect(client.rebuildDocker).toHaveBeenCalledWith("web", {});
      expect(overlay?.isOpen).toBe(false);
    });

    it.each(["", "compose"])("blocks R for Docker group %j", async (group) => {
      const { stdin, client } = renderRouter({
        statuses: [makeStatus({ isDocker: true, group })],
        servicesMeta: dockerMeta(group),
      });
      await pressKey(stdin, "R");
      expect(overlay?.isOpen).toBe(false);
      expect(client.rebuildDocker).not.toHaveBeenCalled();
    });

    it("blocks R while the selected Docker service is busy", async () => {
      const client = createMockClient();
      vi.mocked(client.restartService).mockReturnValueOnce(deferred<void>().promise);
      const { stdin } = renderRouter({
        client,
        statuses: [makeStatus({ isDocker: true })],
        servicesMeta: dockerMeta(),
      });
      await pressKey(stdin, "r");
      expect(client.restartService).toHaveBeenCalledOnce();
      await pressKey(stdin, "R");
      expect(overlay?.isOpen).toBe(false);
      expect(client.rebuildDocker).not.toHaveBeenCalled();
    });

    it.each(["status", "metadata"])(
      "revalidates stale rebuild confirmation against current %s",
      async (source) => {
        const { stdin, client } = enterDockerRebuild();
        await pressKey(stdin, "x");
        expect(overlay?.top?.id).toBe("docker-rebuild");
        act(() => {
          client.emit(
            "session.configReloaded",
            makeSessionSnapshot({
              statuses: [
                parseServiceStatus(
                  makeStatus({ isDocker: true, group: source === "status" ? "" : undefined }),
                ),
              ],
              servicesMeta: dockerMeta(source === "metadata" ? "compose" : undefined),
            }),
          );
        });
        await pressKey(stdin, "\r");
        expect(overlay?.isOpen).toBe(false);
        expect(client.rebuildDocker).not.toHaveBeenCalled();
      },
    );

    it("sends toggled flags as overrides on Enter", async () => {
      const { stdin, client } = enterDockerRebuild();
      await act(async () => {
        /* Flush */
      });
      await pressKey(stdin, "x"); // Warm-up (ignored)
      await pressKey(stdin, " "); // Toggle --build (index 0)
      await pressKey(stdin, "\r");
      expect(client.rebuildDocker).toHaveBeenCalledWith("web", { build: true });
    });
  });

  // ── onTaskComplete via daemon events ─────────────────────────

  it("replaces stale running task history from the reattached snapshot", () => {
    const { client, lastFrame } = renderRouter({
      taskHistory: [
        {
          runId: "old",
          taskKey: "build",
          taskName: "OldBuild",
          result: "running",
          timestamp: 1,
        },
      ],
    });
    expect(lastFrame()).toContain("OldBuild");
    act(() => {
      client.emit(
        "session.snapshot",
        makeSessionSnapshot({
          taskHistory: [
            {
              runId: "new",
              taskKey: "test",
              taskName: "NewTest",
              result: "success",
              timestamp: 2,
            },
          ],
        }),
      );
    });
    expect(lastFrame()).toContain("NewTest");
    expect(lastFrame()).not.toContain("OldBuild");
  });

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

  it("keeps the top-level running record when a dep-graph completion shares its runId", async () => {
    // Manager/hook path: one task.start for the top key, then a dep of the graph
    // Completes carrying the SAME runId. The dep must prepend as its own row and
    // NOT clobber the still-running top-level record (mirrors session matching).
    const client = createMockClient();
    const { lastFrame } = renderRouter({ client });
    client.emit("task.start", "build", "BuildTopLevel", "run_1");
    await act(async () => {
      /* Flush */
    });
    client.emit("task.complete", "lint", "LintDep", "success", "run_1");
    await act(async () => {
      /* Flush */
    });
    const frame = lastFrame() ?? "";
    // Top-level "BuildTopLevel" is still shown as running (not relabeled to the dep).
    expect(frame).toContain("BuildTopLevel");
    expect(frame).toContain("running");
    // The dep appears as its own completed row.
    expect(frame).toContain("LintDep");

    // Top-level completion now resolves the running record.
    client.emit("task.complete", "build", "BuildTopLevel", "success", "run_1");
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame() ?? "").toContain("BuildTopLevel");
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

  // A tmux client attaching with its own stdin at EOF makes the pty emit VEOF
  // (0x04), which tmux hands to the pane as a plain Ctrl-D. A single stray byte
  // Must never stop every service — the end-to-end case lives in the managed
  // Re-attach integration suite.
  it("asks before destroying the session on ctrl+d, and never on the byte alone", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("\x04");
    await act(async () => {
      /* Flush */
    });
    expect(client.destroySession).not.toHaveBeenCalled();
    expect(overlay?.top?.id).toBe("shutdown-confirm");
    // A repeat of the same byte cannot confirm it either.
    stdin.write("\x04");
    expect(client.destroySession).not.toHaveBeenCalled();
  });

  // ── q still works during per-service busy ───────────────────

  it("allows q even when a service is busy", async () => {
    const client = createMockClient();
    client.restartService = vi.fn().mockReturnValue(
      new Promise(() => {
        /* Noop */
      }),
    );
    const { stdin } = renderRouter({ client });
    stdin.write("r"); // Makes service busy (per-service, not global)
    stdin.write("q");
    await act(async () => {
      /* Flush */
    });
    expect(client.detach).toHaveBeenCalledExactlyOnceWith({ detachHost: true });
  });

  // ── ctrl+d still works during per-service busy ────────────

  it("still offers shutdown when a service is busy", async () => {
    const client = createMockClient();
    client.restartService = vi.fn().mockReturnValue(
      new Promise(() => {
        /* Noop */
      }),
    );
    const { stdin } = renderRouter({ client });
    stdin.write("r"); // Makes service busy
    stdin.write("\x04");
    await act(async () => {
      /* Flush */
    });
    expect(overlay?.top?.id).toBe("shutdown-confirm");
  });
});
