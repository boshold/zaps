import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonClient, TerminalActionError } from "../../src/client/daemon-client.js";
import { FAILED_OUTPUT_ID } from "../../src/components/overlay/FailedOutputOverlay.js";
import { OverlayHost } from "../../src/components/overlay/OverlayHost.js";
import { Router } from "../../src/components/Router.js";
import { resolveUiConfig } from "../../src/config/index.js";
import type { ResolvedUiConfig } from "../../src/config/index.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";
import type { ToastApi } from "../../src/hooks/useToasts.js";
import { ToastProvider, useToasts } from "../../src/hooks/useToasts.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { TerminalActionResult } from "../../src/lib/backend/schemas.js";
import { unavailableActions } from "../../src/lib/backend/wire.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { deferred } from "../_helpers/deferred.js";
import { fullCapabilities } from "../_helpers/ui-capabilities.js";

vi.mock("../../src/lib/open.js", () => ({ openInBrowser: vi.fn() }));
vi.mock("../../src/lib/notifier.js", () => ({ notifyFailure: vi.fn() }));

const { notifyFailure } = await import("../../src/lib/notifier.js");

function createMockClient() {
  const client = new DaemonClient("/unused", "test");
  vi.spyOn(client, "uiBound", "get").mockReturnValue(true);
  return Object.assign(client, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    deliverUpgradeNotice: vi.fn(),
    listServices: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
    terminalAction: vi.fn<DaemonClient["terminalAction"]>().mockResolvedValue({
      action: "taskOutput",
      done: true,
    }),
    getTaskOutput: vi.fn().mockResolvedValue({
      runId: "run_1",
      taskKey: "build",
      result: "error",
      lines: ["boom: failed"],
      startedAt: 0,
      endedAt: 1,
    }),
  });
}

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return { name: "web", state: "ready", ports: [3000], retryCount: 0, ...overrides };
}

let overlay: OverlayApi | undefined;
let toasts: ToastApi | undefined;
let unmountRouter: (() => void) | undefined;

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

function AppWrap({
  client,
  presentation,
  children,
}: {
  client: DaemonClient;
  presentation?: ResolvedUiConfig["failOutput"];
  children: ReactNode;
}) {
  return (
    <AppProvider
      client={client}
      paneMap={{}}
      projectName="test-project"
      tasks={[]}
      servicesMeta={[]}
      capabilities={presentation ? fullCapabilities : undefined}
      ui={resolveUiConfig({ failOutput: presentation })}
      statuses={[{ ...makeStatus(), actions: unavailableActions }]}
    >
      {children}
    </AppProvider>
  );
}

function renderRouter(client: DaemonClient, presentation?: ResolvedUiConfig["failOutput"]) {
  const result = render(
    <Providers>
      <AppWrap client={client} presentation={presentation}>
        <Probes />
        <Router initialTaskHistory={[]} />
        <OverlayHost />
      </AppWrap>
    </Providers>,
  );
  unmountRouter = result.unmount;
  return result;
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

  afterEach(async () => {
    await act(async () => unmountRouter?.());
    unmountRouter = undefined;
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
  describe("popup presentation", () => {
    const action = { action: "taskOutput", runId: "run_1" };

    async function openFailedRun(presentation: ResolvedUiConfig["failOutput"] = "popup") {
      const client = createMockClient();
      const result = renderRouter(client, presentation);
      act(() => {
        client.emit("task.complete", "build", "Build", "error", "run_1");
      });
      await waitFor(() => toasts?.toasts.some(({ runId }) => runId === "run_1") === true);
      return { client, ...result };
    }

    it("opens the retained run directly and acknowledges on success", async () => {
      const { stdin, client } = await openFailedRun();
      const pending = deferred<TerminalActionResult>();
      client.terminalAction.mockReturnValueOnce(pending.promise);
      await pressKey(stdin, "f");
      await pressKey(stdin, "f");
      expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
      expect(overlay?.isOpen).toBe(false);
      expect(client.getTaskOutput).not.toHaveBeenCalled();
      expect(toasts?.toasts.map(({ runId }) => runId)).toEqual(["run_1"]);
      await act(async () => {
        pending.resolve({ action: "taskOutput", done: true });
      });
      expect(overlay?.isOpen).toBe(false);
      expect(toasts?.toasts).toEqual([]);
      expect(client.runTask).not.toHaveBeenCalled();
    });

    it("opens one fallback and fetches the retained run after backend_unavailable", async () => {
      const { stdin, client } = await openFailedRun();
      const pending = deferred<TerminalActionResult>();
      client.terminalAction.mockReturnValueOnce(pending.promise);
      await pressKey(stdin, "f");
      expect(overlay?.isOpen).toBe(false);
      expect(client.getTaskOutput).not.toHaveBeenCalled();
      await act(async () => {
        pending.reject(new TerminalActionError("popup unavailable", "backend_unavailable"));
      });
      expect(overlay?.stack.map(({ id }) => id)).toEqual([FAILED_OUTPUT_ID]);
      expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
      expect(client.getTaskOutput).toHaveBeenCalledExactlyOnceWith("run_1");
      expect(toasts?.toasts.map(({ runId }) => runId)).toEqual(["run_1"]);
      await pressKey(stdin, "\x1B");
      expect(toasts?.toasts).toEqual([]);
      expect(client.runTask).not.toHaveBeenCalled();
    });

    it("keeps the failure pending and opens no overlay on terminal_busy", async () => {
      const { stdin, client } = await openFailedRun();
      client.terminalAction.mockRejectedValueOnce(
        new TerminalActionError("popup occupied", "terminal_busy"),
      );
      await pressKey(stdin, "f");
      expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
      expect(overlay?.isOpen).toBe(false);
      expect(client.getTaskOutput).not.toHaveBeenCalled();
      expect(toasts?.toasts.map(({ runId }) => runId)).toEqual(["run_1"]);
    });

    it("shows disconnect without falling back or acknowledging the pending failure", async () => {
      const { stdin, client, lastFrame } = await openFailedRun();
      const pending = deferred<TerminalActionResult>();
      client.terminalAction.mockReturnValueOnce(pending.promise);
      await pressKey(stdin, "f");
      await act(async () => {
        client.emit("disconnect");
        pending.reject(new Error("daemon connection closed"));
      });
      expect(lastFrame()).toContain("Daemon connection lost");
      expect(overlay?.isOpen).toBe(false);
      expect(client.getTaskOutput).not.toHaveBeenCalled();
      expect(toasts?.toasts.map(({ runId }) => runId)).toEqual(["run_1"]);
    });

    it.each(["terminal_busy", "backend_unavailable"] as const)(
      "keeps the existing output overlay after manual escalation returns %s",
      async (code) => {
        const { stdin, client } = await openFailedRun("overlay");
        client.terminalAction.mockRejectedValueOnce(new TerminalActionError("popup error", code));
        await pressKey(stdin, "f");
        const output = overlay?.top;
        await pressKey(stdin, "k");
        await pressKey(stdin, "p");
        expect(client.terminalAction).toHaveBeenCalledExactlyOnceWith(action);
        expect(overlay?.top).toBe(output);
        expect(client.getTaskOutput).toHaveBeenCalledExactlyOnceWith("run_1");
        expect(toasts?.toasts.map(({ runId }) => runId)).toEqual(["run_1"]);
      },
    );
  });
});
