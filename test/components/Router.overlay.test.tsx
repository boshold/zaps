import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DaemonClient } from "../../src/client/daemon-client.js";
import { OverlayHost } from "../../src/components/overlay/OverlayHost.js";
import { Router } from "../../src/components/Router.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import { parseServiceStatus } from "../../src/lib/backend/wire.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { deferred } from "../_helpers/deferred.js";

vi.mock("../../src/lib/open.js", () => ({ openInBrowser: vi.fn() }));

function createMockClient(): DaemonClient {
  const client = new DaemonClient("/unused", "test");
  vi.spyOn(client, "connected", "get").mockReturnValue(true);
  vi.spyOn(client, "uiBound", "get").mockReturnValue(true);
  return Object.assign(client, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    detach: vi.fn<DaemonClient["detach"]>().mockResolvedValue(undefined),
    deliverUpgradeNotice: vi.fn(),
    restartService: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    restartAll: vi.fn().mockResolvedValue(undefined),
    destroySession: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
    reloadConfig: vi.fn().mockResolvedValue(undefined),
  });
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
      <AppProvider
        client={client}
        paneMap={{}}
        projectName="proj"
        tasks={[]}
        servicesMeta={[]}
        statuses={statuses.map((status) => parseServiceStatus(status))}
      >
        <OverlayController />
        <Router initialTaskHistory={[]} />
        <OverlayHost />
      </AppProvider>
    </OverlayProvider>,
  );
}

const STATUS: ServiceStatus = { name: "web", state: "ready", ports: [3000], retryCount: 0 };

describe("Router overlay gating", () => {
  it("Ctrl-C detaches without triggering the dashboard reload shortcut", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("\x03");
    await vi.waitFor(() => expect(client.detach).toHaveBeenCalledOnce());
    expect(client.reloadConfig).not.toHaveBeenCalled();
    expect(client.restartService).not.toHaveBeenCalled();
    expect(client.destroySession).not.toHaveBeenCalled();
  });

  it.each(["\x12", "\x13", "\x1bc"])("ignores modified dashboard shortcuts %j", (key) => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write(key);
    expect(client.reloadConfig).not.toHaveBeenCalled();
    expect(client.restartService).not.toHaveBeenCalled();
  });

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
      client.emit("disconnect");
    });
    await flush();
    expect(overlay?.isOpen).toBe(false);
  });

  it("does not open the palette while disconnected (no one-frame flash)", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    act(() => {
      client.emit("disconnect");
    });
    await flush();
    stdin.write("\x0B"); // Ctrl-K — gated behind the !connected guard now
    await flush();
    expect(overlay?.isOpen).toBe(false);
  });
});

describe("Router help overlay", () => {
  afterEach(() => {
    overlay = undefined;
  });

  it("opens the help overlay on `?`", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("?");
    await flush();
    expect(overlay?.top?.id).toBe("help");
  });

  it("opens help from the palette's Help command", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);
    stdin.write("\x0B"); // Ctrl-K
    await flush();
    for (const ch of "help") {
      stdin.write(ch);
      await flush();
    }
    stdin.write("\r"); // Run the highlighted Help command
    await flush();
    // Palette closed, help opened in its place.
    expect(overlay?.top?.id).toBe("help");
  });
});

// The shutdown gate lives here (not in Router.test.tsx) because it needs a real
// `OverlayHost` mounted: the overlay owns its own `useInput`.
describe("Router shutdown confirmation", () => {
  afterEach(() => {
    overlay = undefined;
  });

  it("tears the session down only after `y`", async () => {
    const client = createMockClient();
    const ack = deferred<void>();
    vi.mocked(client.destroySession).mockReturnValueOnce(ack.promise);
    const { stdin } = renderWithOverlay(client, [STATUS]);

    stdin.write("\x04"); // Ctrl-D
    await flush();
    expect(overlay?.top?.id).toBe("shutdown-confirm");
    expect(client.destroySession).not.toHaveBeenCalled();

    stdin.write("y");
    await flush();
    expect(client.destroySession).toHaveBeenCalledTimes(1);
    expect(overlay?.isOpen).toBe(false);
    stdin.write("q");
    stdin.write("\x04");
    await flush();
    expect(client.detach).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(overlay?.isOpen).toBe(false);
    await act(async () => ack.resolve());
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  // A tmux client attaching with its own stdin at EOF makes the pty emit VEOF
  // (0x04), which tmux hands to the pane as a plain Ctrl-D. Repeats of that byte
  // Must stay harmless — only a distinct key confirms.
  it("survives a stream of stray Ctrl-D bytes", async () => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);

    stdin.write("\x04");
    await flush();
    stdin.write("\x04");
    await flush();
    stdin.write("\x04");
    await flush();

    expect(client.destroySession).not.toHaveBeenCalled();
  });

  it.each(["n", "\r"])("cancels on %j", async (input) => {
    const client = createMockClient();
    const { stdin } = renderWithOverlay(client, [STATUS]);

    stdin.write("d");
    await flush();
    expect(overlay?.top?.id).toBe("shutdown-confirm");

    stdin.write(input);
    await flush();
    expect(client.destroySession).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(overlay?.isOpen).toBe(false);
  });

  it("asks before palette shutdown and keeps the UI usable after cleanup failure", async () => {
    const client = createMockClient();
    const ack = deferred<void>();
    const failure = new Error("Session cleanup incomplete");
    vi.mocked(client.destroySession).mockReturnValueOnce(ack.promise);
    const { stdin, lastFrame, unmount } = renderWithOverlay(client, [STATUS]);

    try {
      await act(async () => stdin.write(":"));
      await vi.waitFor(() => expect(overlay?.top?.id).toBe("command-palette"));
      await act(async () => stdin.write("shut down"));
      await act(async () => stdin.write("\r"));
      await vi.waitFor(() => expect(overlay?.top?.id).toBe("shutdown-confirm"));
      expect(client.destroySession).not.toHaveBeenCalled();
      await act(async () => stdin.write("y"));
      await vi.waitFor(() => expect(client.destroySession).toHaveBeenCalledOnce());
      expect(overlay?.isOpen).toBe(false);
      expect(client.detach).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("Shutdown failed.");
      await act(async () => stdin.write("d"));
      expect(overlay?.isOpen).toBe(false);

      await act(async () => ack.reject(failure));
      await vi.waitFor(() =>
        expect(lastFrame()).toContain("Shutdown failed. Session cleanup incomplete"),
      );
      expect(client.destroySession).toHaveBeenCalledOnce();
      expect(client.detach).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      await act(async () => stdin.write("d"));
      await vi.waitFor(() => expect(overlay?.top?.id).toBe("shutdown-confirm"));
    } finally {
      if (vi.mocked(client.destroySession).mock.calls.length > 0) {
        await act(async () => ack.reject(failure));
      }
      unmount();
    }
  });
});
