import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { Router } from "../../src/components/Router.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

vi.mock("../../src/lib/open.js", () => ({ openInBrowser: vi.fn() }));
vi.mock("../../src/lib/tmux.js", () => ({
  zoomPane: vi.fn(),
  editPaneCapture: vi.fn().mockResolvedValue(undefined),
}));

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    restartService: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    restartAll: vi.fn().mockResolvedValue(undefined),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
    reloadConfig: vi.fn().mockResolvedValue(undefined),
  });
  return client as unknown as DaemonClient;
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

let overlay: OverlayApi | undefined;

function OverlayController() {
  overlay = useOverlay();
  return null;
}

function renderWithOverlay(client: DaemonClient, statuses: ServiceStatus[]) {
  return render(
    <OverlayProvider>
      <AppProvider client={client} paneMap={{}} projectName="proj" tasks={[]} servicesMeta={[]}>
        <OverlayController />
        <Router initialStatuses={statuses} initialTaskHistory={[]} />
      </AppProvider>
    </OverlayProvider>,
  );
}

const STATUS: ServiceStatus = { name: "web", state: "ready", ports: [3000], retryCount: 0 };

describe("Router overlay gating", () => {
  it("fires dashboard quick keys when no overlay is open", () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("web");
  });

  it("makes dashboard quick keys inert while an overlay is open", () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);

    act(() => overlay?.push({ id: "palette", render: () => null }));
    stdin.write("r");
    expect(client.restartService).not.toHaveBeenCalled();

    // Popping the overlay restores base-view input ownership.
    act(() => overlay?.pop());
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("web");
  });
});

describe("Router command palette", () => {
  afterEach(() => {
    overlay = undefined;
  });

  it("opens the palette on Ctrl-K", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("\x0B"); // Ctrl-K
    await flush();
    // The palette renders position="absolute" (uncapturable), so assert the
    // Overlay stack opened with the palette's id rather than the frame text.
    expect(overlay?.isOpen).toBe(true);
    expect(overlay?.top?.id).toBe("command-palette");
  });

  it("opens the palette on ':'", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write(":");
    await flush();
    expect(overlay?.isOpen).toBe(true);
  });

  it("makes the dashboard quick keys inert while the palette is open, restoring them on close", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("\x0B"); // Ctrl-K — palette steals input (Q7 coexist: keys yield while open)
    await flush();
    stdin.write("r");
    await flush();
    expect(client.restartService).not.toHaveBeenCalled();

    act(() => overlay?.pop());
    stdin.write("r");
    expect(client.restartService).toHaveBeenCalledWith("web");
  });

  it("force-closes the palette when the daemon disconnects", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("\x0B"); // Ctrl-K
    await flush();
    expect(overlay?.isOpen).toBe(true);

    act(() => {
      (client as unknown as EventEmitter).emit("disconnect");
    });
    await flush();
    expect(overlay?.isOpen).toBe(false);
  });
});
