import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { FAILED_OUTPUT_ID } from "../../src/components/overlay/FailedOutputOverlay.js";
import { OverlayHost } from "../../src/components/overlay/OverlayHost.js";
import { Router } from "../../src/components/Router.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";
import type { ToastApi } from "../../src/hooks/useToasts.js";
import { ToastProvider, useToasts } from "../../src/hooks/useToasts.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

vi.mock("../../src/lib/open.js", () => ({ openInBrowser: vi.fn() }));
vi.mock("../../src/lib/tmux.js", () => ({
  zoomPane: vi.fn(),
  editPaneCapture: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/lib/task/popup-picker.js", () => ({
  popupPickerAvailable: vi.fn().mockResolvedValue(false),
  runPopupPicker: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/lib/task/output-popup.js", () => ({
  outputPopupAvailable: vi.fn().mockResolvedValue(false),
  showOutputPopup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/lib/notifier.js", () => ({ notifyFailure: vi.fn() }));

const { notifyFailure } = await import("../../src/lib/notifier.js");

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    session: "test",
    listServices: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
    getTaskOutput: vi.fn().mockResolvedValue({
      runId: "run_1",
      taskKey: "build",
      result: "error",
      lines: ["boom: failed"],
      startedAt: 0,
      endedAt: 1,
    }),
  });
  return client as unknown as DaemonClient;
}

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return { name: "web", state: "ready", ports: [3000], retryCount: 0, ...overrides };
}

let overlay: OverlayApi | undefined;
let toasts: ToastApi | undefined;

function Probes() {
  overlay = useOverlay();
  toasts = useToasts();
  return null;
}

// Wrappers keep inline JSX nesting shallow (jsx-max-depth) — providers split
// Into their own components so renderRouter stays at the same depth as Router.test.
function Providers({ children }: { children: ReactNode }) {
  return (
    <OverlayProvider>
      <ToastProvider>{children}</ToastProvider>
    </OverlayProvider>
  );
}

function AppWrap({ client, children }: { client: DaemonClient; children: ReactNode }) {
  return (
    <AppProvider
      client={client}
      paneMap={{}}
      projectName="test-project"
      tasks={[]}
      servicesMeta={[]}
    >
      {children}
    </AppProvider>
  );
}

function renderRouter(client: DaemonClient) {
  return render(
    <Providers>
      <AppWrap client={client}>
        <Probes />
        <Router initialStatuses={[makeStatus()]} initialTaskHistory={[]} />
        <OverlayHost />
      </AppWrap>
    </Providers>,
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function pressKey(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/**
 * Poll a predicate inside `act()` until it holds. The failed-output overlay
 * Mounts only after an async `getTaskOutput` fetch resolves, so a fixed sleep
 * Races under full-suite load — wait on the actual condition instead.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, pollMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    // eslint-disable-next-line no-await-in-loop -- sequential poll
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    });
  }
}

describe("Router failure → toast / notifier / failed-output overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    overlay = undefined;
    toasts = undefined;
  });

  it("on a failed task.complete: sticky toast + desktop notification", async () => {
    const client = createMockClient();
    renderRouter(client);
    client.emit("task.complete", "build", "Build", "error", "run_1");
    await flush();
    expect(toasts?.toasts.some((t) => t.sticky && t.runId === "run_1")).toBe(true);
    expect(notifyFailure).toHaveBeenCalledWith("Build", "osc9");
  });

  it("on a successful task.complete: transient toast, no notification", async () => {
    const client = createMockClient();
    renderRouter(client);
    client.emit("task.complete", "build", "Build", "success", "run_2");
    await flush();
    expect(toasts?.toasts.some((t) => !t.sticky && t.level === "success")).toBe(true);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it("surfaces a config.notice as a transient toast (success maps 1:1)", async () => {
    const client = createMockClient();
    renderRouter(client);
    client.emit("config.notice", "success", "config reloaded");
    await flush();
    expect(
      toasts?.toasts.some(
        (t) => !t.sticky && t.level === "success" && t.message === "config reloaded",
      ),
    ).toBe(true);
  });

  it("maps a warn config.notice to a non-sticky info toast", async () => {
    const client = createMockClient();
    renderRouter(client);
    client.emit("config.notice", "warn", "deprecated option");
    await flush();
    expect(
      toasts?.toasts.some(
        (t) => !t.sticky && t.level === "info" && t.message === "deprecated option",
      ),
    ).toBe(true);
  });

  it("`f` opens the failed-output overlay for the latest sticky failure", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter(client);
    client.emit("task.complete", "build", "Build", "error", "run_1");
    await flush();
    await pressKey(stdin, "f");
    await waitFor(() => overlay?.top?.id === FAILED_OUTPUT_ID);
    expect(overlay?.top?.id).toBe(FAILED_OUTPUT_ID);
    expect(client.getTaskOutput).toHaveBeenCalledWith("run_1");
  }, 20_000);

  it("`f` is a no-op when there is no sticky failure", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter(client);
    await pressKey(stdin, "f");
    await flush();
    expect(overlay?.isOpen).toBe(false);
  });

  it("`x` acknowledges (clears) the sticky failure", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter(client);
    client.emit("task.complete", "build", "Build", "error", "run_1");
    await flush();
    expect(toasts?.toasts.filter((t) => t.sticky).length).toBeGreaterThan(0);
    await pressKey(stdin, "x");
    expect(toasts?.toasts.filter((t) => t.sticky).length).toBe(0);
  });

  it("closing the overlay (Esc) acks that run's sticky toast", async () => {
    const client = createMockClient();
    const { stdin } = renderRouter(client);
    client.emit("task.complete", "build", "Build", "error", "run_1");
    await flush();
    await pressKey(stdin, "f");
    await waitFor(() => overlay?.top?.id === FAILED_OUTPUT_ID);
    expect(overlay?.top?.id).toBe(FAILED_OUTPUT_ID);
    // Esc → OverlayHost pops → overlay unmounts → onClose acks run_1.
    await pressKey(stdin, "\x1B");
    await waitFor(() => overlay?.isOpen === false);
    expect(overlay?.isOpen).toBe(false);
    await waitFor(() => toasts?.toasts.filter((t) => t.sticky && t.runId === "run_1").length === 0);
    expect(toasts?.toasts.filter((t) => t.sticky && t.runId === "run_1").length).toBe(0);
  }, 20_000);
});
