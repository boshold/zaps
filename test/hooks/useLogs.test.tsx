import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { useLogs } from "../../src/hooks/useLogs.js";

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
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
  });
  return client as unknown as DaemonClient;
}

describe("useLogs", () => {
  it("returns empty lines when serviceName is null", () => {
    const client = createMockClient();
    function Wrapper() {
      const { lines } = useLogs(client, null);
      return <Text>count:{lines.length}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("count:0");
  });

  it("scrollUp disables autoScroll, increments offset, and clamps at the oldest line", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue(["a", "b", "c"]);
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, "api");
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);
    await act(async () => {
      /* Load snapshot (3 lines → max offset 2) */
    });

    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("autoScroll:false");
    expect(lastFrame()).toContain("offset:1");

    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");

    // 3 lines → cannot scroll past the oldest line into blank space.
    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");
  });

  it("does not scroll when there are no lines", () => {
    const client = createMockClient();
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, null);
      return <Text>offset:{hookRef.offset}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:0");
  });

  it("scrollDown decrements offset and re-enables autoScroll at 0", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue(["a", "b", "c"]);
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, "api");
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);
    await act(async () => {
      /* Load snapshot */
    });

    act(() => {
      hookRef!.scrollUp();
    });
    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");
    expect(lastFrame()).toContain("autoScroll:false");

    act(() => {
      hookRef!.scrollDown();
    });
    expect(lastFrame()).toContain("offset:1");
    expect(lastFrame()).toContain("autoScroll:false");

    act(() => {
      hookRef!.scrollDown();
    });
    expect(lastFrame()).toContain("offset:0");
    expect(lastFrame()).toContain("autoScroll:true");
  });

  it("resets offset and autoScroll when the service changes", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue(["a", "b", "c"]);
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper({ service }: { service: string | null }) {
      hookRef = useLogs(client, service);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame, rerender } = render(<Wrapper service="api" />);
    await act(async () => {
      /* Load snapshot */
    });

    act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:1");
    expect(lastFrame()).toContain("autoScroll:false");

    // Switching services resets scroll state.
    act(() => {
      rerender(<Wrapper service="db" />);
    });
    expect(lastFrame()).toContain("offset:0");
    expect(lastFrame()).toContain("autoScroll:true");
  });
});

describe("useLogs event streaming", () => {
  it("loads snapshot and receives new lines via events", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue(["line1", "line2"]);

    function Wrapper() {
      const { lines } = useLogs(client, "api");
      return <Text>lines:{lines.join("|")}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(async () => {
      /* Flush */
    });

    expect(vi.mocked(client.getLogSnapshot)).toHaveBeenCalledWith("api");
    expect(lastFrame()).toContain("line1|line2");

    act(() => {
      client.emit("log.lines", "api", ["line3"]);
    });
    expect(lastFrame()).toContain("line1|line2|line3");
  });

  it("ignores log events for other services", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue(["line1"]);

    function Wrapper() {
      const { lines } = useLogs(client, "api");
      return <Text>lines:{lines.join("|")}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toContain("line1");

    act(() => {
      client.emit("log.lines", "db", ["db-line"]);
    });
    expect(lastFrame()).not.toContain("db-line");
  });

  it("unsubscribes from events on unmount", () => {
    const client = createMockClient();

    function Wrapper() {
      const { lines } = useLogs(client, "api");
      return <Text>lines:{lines.length}</Text>;
    }

    const { unmount } = render(<Wrapper />);
    expect(client.listenerCount("log.lines")).toBe(1);

    unmount();
    expect(client.listenerCount("log.lines")).toBe(0);
  });

  it("caps client-side lines at 10,000 (drops oldest, keeps newest)", async () => {
    const client = createMockClient();
    vi.mocked(client.getLogSnapshot).mockResolvedValue([]);
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, "api");
      return <Text>n:{hookRef.lines.length}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    await act(async () => {
      /* Flush snapshot */
    });

    act(() => {
      client.emit(
        "log.lines",
        "api",
        Array.from({ length: 6000 }, (_, i) => `a${i}`),
      );
    });
    act(() => {
      client.emit(
        "log.lines",
        "api",
        Array.from({ length: 6000 }, (_, i) => `b${i}`),
      );
    });

    expect(lastFrame()).toContain("n:10000");
    const last = hookRef!.lines[hookRef!.lines.length - 1];
    expect(last).toBe("b5999");
    // The oldest lines were dropped, not the newest.
    expect(hookRef!.lines.includes("a0")).toBe(false);
  });

  it("buffers events arriving during the snapshot fetch and orders them after it", async () => {
    const client = createMockClient();
    let resolveSnapshot: (lines: string[]) => void = () => undefined;
    vi.mocked(client.getLogSnapshot).mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    function Wrapper() {
      const { lines } = useLogs(client, "api");
      return <Text>lines:{lines.join("|")}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    // A live event arrives BEFORE the snapshot resolves — it must be buffered.
    act(() => {
      client.emit("log.lines", "api", ["live1"]);
    });
    expect(lastFrame()).not.toContain("live1");

    // Snapshot resolves → snapshot lines first, then the buffered live line.
    await act(async () => {
      resolveSnapshot(["snap1", "snap2"]);
    });
    expect(lastFrame()).toContain("lines:snap1|snap2|live1");

    // Subsequent live events append directly.
    act(() => {
      client.emit("log.lines", "api", ["live2"]);
    });
    expect(lastFrame()).toContain("lines:snap1|snap2|live1|live2");
  });

  it("ignores a snapshot that resolves after the service already switched", async () => {
    const client = createMockClient();
    let resolveApi: (lines: string[]) => void = () => undefined;
    vi.mocked(client.getLogSnapshot).mockImplementation(async (svc: string) =>
      svc === "api"
        ? new Promise<string[]>((resolve) => {
            resolveApi = resolve;
          })
        : ["db1"],
    );

    function Wrapper({ service }: { service: string }) {
      const { lines } = useLogs(client, service);
      return <Text>lines:{lines.join("|")}</Text>;
    }

    const { lastFrame, rerender } = render(<Wrapper service="api" />);

    // Switch to db before api's snapshot resolves.
    await act(async () => {
      rerender(<Wrapper service="db" />);
    });
    expect(lastFrame()).toContain("lines:db1");

    // The stale api snapshot now resolves — it must not overwrite db's lines.
    await act(async () => {
      resolveApi(["api1", "api2"]);
    });
    expect(lastFrame()).toContain("lines:db1");
    expect(lastFrame()).not.toContain("api1");
  });
});
