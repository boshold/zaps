import { EventEmitter } from "node:events";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

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

// Flush React/Ink reconciler
async function act(fn: () => void): Promise<void> {
  fn();
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
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

  it("scrollUp sets autoScroll to false and increments offset", async () => {
    const client = createMockClient();
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    expect(lastFrame()).toContain("autoScroll:true");
    expect(lastFrame()).toContain("offset:0");

    await act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("autoScroll:false");
    expect(lastFrame()).toContain("offset:1");

    await act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");
  });

  it("scrollDown decrements offset and re-enables autoScroll at 0", async () => {
    const client = createMockClient();
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    // Scroll up twice
    await act(() => {
      hookRef!.scrollUp();
    });
    await act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");
    expect(lastFrame()).toContain("autoScroll:false");

    // Scroll down once
    await act(() => {
      hookRef!.scrollDown();
    });
    expect(lastFrame()).toContain("offset:1");
    expect(lastFrame()).toContain("autoScroll:false");

    // Scroll down to 0 -> autoScroll re-enabled
    await act(() => {
      hookRef!.scrollDown();
    });
    expect(lastFrame()).toContain("offset:0");
    expect(lastFrame()).toContain("autoScroll:true");
  });

  it("resetScroll sets offset to 0 and autoScroll to true", async () => {
    const client = createMockClient();
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(client, null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    // Scroll up
    await act(() => {
      hookRef!.scrollUp();
    });
    await act(() => {
      hookRef!.scrollUp();
    });
    expect(lastFrame()).toContain("offset:2");

    // Reset
    await act(() => {
      hookRef!.resetScroll();
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

    // Wait for snapshot to load
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(vi.mocked(client.getLogSnapshot)).toHaveBeenCalledWith("api");
    expect(lastFrame()).toContain("line1|line2");

    // Emit new lines via client event
    await act(() => {
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

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(lastFrame()).toContain("line1");

    // Emit lines for a different service
    await act(() => {
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
});
