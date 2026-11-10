import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { OverlayHost } from "../../src/components/overlay/OverlayHost.js";
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
  zoomPane: vi.fn(),
  editPaneCapture: vi.fn().mockResolvedValue(undefined),
  // Quitting asks tmux to detach the client (managed mode only).
  detachClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/task/popup-picker.js", () => ({
  popupPickerAvailable: vi.fn().mockResolvedValue(false),
  runPopupPicker: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/task/output-popup.js", () => ({
  outputPopupAvailable: vi.fn().mockResolvedValue(true),
  showOutputPopup: vi.fn().mockResolvedValue(undefined),
}));

const { outputPopupAvailable, showOutputPopup } =
  await import("../../src/lib/task/output-popup.js");
const { openInBrowser } = await import("../../src/lib/open.js");
const { zoomPane, editPaneCapture, detachClient } = await import("../../src/lib/tmux.js");
const { popupPickerAvailable, runPopupPicker } = await import("../../src/lib/task/popup-picker.js");

// ── helpers ────────────────────────────────────────────────────────────

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    uiBound: true,
    deliverUpgradeNotice: vi.fn(),
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
    runTaskInPane: vi.fn().mockResolvedValue({ runId: "run_1", paneId: "%9" }),
    getTaskOutput: vi.fn(async (runId: string) => ({
      runId,
      taskKey: "build",
      result: "error",
      lines: ["failed"],
      startedAt: 0,
    })),
    rebuildDocker: vi.fn().mockResolvedValue(undefined),
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

  it("zooms the projected pane with z even if the pane map has a different target", () => {
    const paneMap = { web: "%2" };
    const { stdin } = renderRouter({
      paneMap,
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus({ paneId: "%1" }), actions: liveActions }],
    });
    stdin.write("z");
    expect(zoomPane).toHaveBeenCalledWith("%1");
  });

  it("does not zoom without a projected pane target", () => {
    const { stdin } = renderRouter({
      paneMap: {},
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus(), actions: liveActions }],
    });
    stdin.write("z");
    expect(zoomPane).not.toHaveBeenCalled();
  });

  // ── dashboard input: zoom TUI pane (Z) ─────────────────────

  it("zooms TUI pane with Z key", () => {
    const paneMap = { "@tui": "%0", web: "%1" };
    const { stdin } = renderRouter({
      paneMap,
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus(), actions: liveActions }],
    });
    stdin.write("Z");
    expect(zoomPane).toHaveBeenCalledWith("%0");
  });

  // ── dashboard input: edit pane capture (E) ───────────────────

  it("captures pane with E key", () => {
    const paneMap = { web: "%1" };
    const { stdin } = renderRouter({
      paneMap,
      capabilities: fullCapabilities,
      statuses: [{ ...makeStatus({ paneId: "%1" }), actions: liveActions }],
    });
    stdin.write("E");
    expect(editPaneCapture).toHaveBeenCalledWith("%1", "web");
  });

  // ── dashboard input: detached services disable pane actions ──

  it("does not zoom a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true, paneId: "%1" })];
    const { stdin } = renderRouter({
      statuses,
      capabilities: fullCapabilities,
      paneMap: { worker: "%1" },
    });
    stdin.write("z");
    expect(zoomPane).not.toHaveBeenCalled();
  });

  it("does not edit-capture a detached service even if a pane is mapped", () => {
    const statuses = [makeStatus({ name: "worker", isDetached: true, paneId: "%1" })];
    const { stdin } = renderRouter({
      statuses,
      capabilities: fullCapabilities,
      paneMap: { worker: "%1" },
    });
    stdin.write("E");
    expect(editPaneCapture).not.toHaveBeenCalled();
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
    "suppresses pane hotkeys and popup probes with %s capabilities",
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
      expect(zoomPane).not.toHaveBeenCalled();
      expect(editPaneCapture).not.toHaveBeenCalled();
      expect(openInBrowser).toHaveBeenCalledWith("http://localhost:3000");
      expect(client.restartService).toHaveBeenCalledWith("web");

      await pressKey(stdin, "t");
      expect(popupPickerAvailable).not.toHaveBeenCalled();
      expect(runPopupPicker).not.toHaveBeenCalled();
      expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
      await pressKey(stdin, "\t");
      await pressKey(stdin, "\t");
      if (capabilities.taskPanes) {
        expect(client.runTaskInPane).toHaveBeenCalledExactlyOnceWith("build");
      } else {
        expect(client.runTaskInPane).not.toHaveBeenCalled();
        expect(client.runTask).not.toHaveBeenCalled();
        expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
        await pressKey(stdin, "\r");
        expect(client.runTask).toHaveBeenCalledExactlyOnceWith("build", {});
      }
      expect(overlay?.isOpen).toBe(false);

      act(() => {
        client.emit("task.complete", "build", "Build", "error", "failed-run");
      });
      await pressKey(stdin, "f");
      expect(overlay?.top?.id).toBe("failed-output");
      await pressKey(stdin, "p");
      expect(outputPopupAvailable).not.toHaveBeenCalled();
      expect(showOutputPopup).not.toHaveBeenCalled();
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
    expect(zoomPane).toHaveBeenCalledExactlyOnceWith("%1");
    act(() => {
      client.emit("service.stateChange", "web", { ...stopped, actions: unavailableActions });
    });
    await pressKey(stdin, "z");
    await pressKey(stdin, "E");
    await pressKey(stdin, "Z");
    expect(vi.mocked(zoomPane).mock.calls).toEqual([["%1"], ["%0"]]);
    expect(editPaneCapture).not.toHaveBeenCalled();
  });

  it.each([
    ["zoom", zoomPane],
    ["edit", editPaneCapture],
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
    expect(action).toHaveBeenCalledOnce();
    expect(overlay?.isOpen).toBe(false);
    await pressKey(stdin, ":");
    expect(overlay?.top?.id).toBe("command-palette");
    await pressKey(stdin, query);
    act(() => {
      client.emit("service.stateChange", "web", { ...stopped, actions: unavailableActions });
    });
    await pressKey(stdin, "\r");
    expect(overlay?.isOpen).toBe(false);
    expect(action).toHaveBeenCalledOnce();
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
    expect(client.runTask).toHaveBeenCalledExactlyOnceWith("build", {});
    expect(overlay?.isOpen).toBe(false);
  });

  it("checks popup capability again after the picker probe resolves", async () => {
    const probe = deferred<boolean>();
    vi.mocked(popupPickerAvailable).mockReturnValueOnce(probe.promise);
    const tasks = [{ key: "build", name: "Build", description: null }];
    const ui = { task: { popupPicker: true } };
    const { stdin, client } = renderRouter({
      tasks,
      capabilities: fullCapabilities,
      ui: resolveUiConfig(ui),
    });
    await pressKey(stdin, "t");
    expect(popupPickerAvailable).toHaveBeenCalledOnce();
    act(() => {
      client.emit("session.configReloaded", makeSessionSnapshot({ tasks, ui }));
    });
    await act(async () => {
      probe.resolve(true);
    });
    expect(runPopupPicker).not.toHaveBeenCalled();
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
  });

  it("disables escalation in an open output overlay after a capability refresh", async () => {
    const { stdin, client } = renderRouter({ capabilities: fullCapabilities });
    act(() => {
      client.emit("task.complete", "build", "Build", "error", "failed-run");
    });
    await pressKey(stdin, "f");
    expect(overlay?.top?.id).toBe("failed-output");
    expect(outputPopupAvailable).toHaveBeenCalledOnce();
    await pressKey(stdin, "p");
    expect(showOutputPopup).toHaveBeenCalledOnce();
    act(() => {
      client.emit("session.configReloaded", makeSessionSnapshot());
    });
    await pressKey(stdin, "p");
    expect(showOutputPopup).toHaveBeenCalledOnce();
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

  it("disconnects client on q", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("q");
    // Quitting first asks tmux to detach the client (a no-op outside a managed
    // Session), so the disconnect lands one microtask later.
    await act(async () => {
      /* Flush */
    });
    expect(client.disconnect).toHaveBeenCalled();
  });

  it("detaches the tmux client on q in a managed session (F2)", async () => {
    vi.stubEnv("ZAPS_MANAGED_TMUX", "1");
    vi.stubEnv("TMUX", "/tmp/tmux-1000/zaps,42,0");
    const client = createMockClient();
    const { stdin } = renderRouter({ client });
    stdin.write("q");
    await act(async () => {
      /* Flush */
    });
    expect(detachClient).toHaveBeenCalledWith();
    expect(client.disconnect).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("does not touch tmux on q in a personal session", async () => {
    const { stdin } = renderRouter();
    stdin.write("q");
    await act(async () => {
      /* Flush */
    });
    expect(detachClient).not.toHaveBeenCalled();
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
    expect(client.runTask).toHaveBeenCalledWith("migrate", {});
    expect(overlay?.isOpen).toBe(false);
  });

  // ── optional fzf popup picker (P04-T05) ──────────────────────

  it("opens the fzf popup picker and runs the selection in the background when enabled + available", async () => {
    vi.mocked(popupPickerAvailable).mockResolvedValue(true);
    vi.mocked(runPopupPicker).mockResolvedValue("migrate");
    const client = createMockClient();
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({
      tasks,
      client,
      capabilities: { ...unavailableCapabilities, popups: true },
      ui: resolveUiConfig({ task: { popupPicker: true } }),
    });
    await pressKey(stdin, "t");
    // Let the async popup flow settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(runPopupPicker).toHaveBeenCalled();
    expect(client.runTask).toHaveBeenCalledWith("migrate", {});
    // No in-app overlay — the popup is the whole UI.
    expect(overlay?.isOpen).toBe(false);
  });

  it("falls back to the in-app picker when the popup is unavailable (old tmux / no fzf)", async () => {
    vi.mocked(popupPickerAvailable).mockResolvedValue(false);
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({
      tasks,
      capabilities: { ...unavailableCapabilities, popups: true },
      ui: resolveUiConfig({ task: { popupPicker: true } }),
    });
    await pressKey(stdin, "t");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(runPopupPicker).not.toHaveBeenCalled();
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
  });

  it("falls back to the in-app picker when the popup launch errors", async () => {
    vi.mocked(popupPickerAvailable).mockResolvedValue(true);
    vi.mocked(runPopupPicker).mockRejectedValue(new Error("popup blew up"));
    const tasks: TaskInfo[] = [{ key: "migrate", name: "Run migrations", description: null }];
    const { stdin } = renderRouter({
      tasks,
      capabilities: { ...unavailableCapabilities, popups: true },
      ui: resolveUiConfig({ task: { popupPicker: true } }),
    });
    await pressKey(stdin, "t");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(overlay?.top?.id).toBe(TASK_PICKER_ID);
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
    expect(client.disconnect).toHaveBeenCalled();
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
