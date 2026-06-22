import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import type { Connection } from "../../src/hooks/useConnection.js";
import { useConnection } from "../../src/hooks/useConnection.js";

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  });
  return client as unknown as DaemonClient;
}

let captured: Connection | undefined;

function Probe({ client }: { client: DaemonClient }) {
  captured = useConnection(client);
  return <Text>{captured.connected ? "ONLINE" : "OFFLINE"}</Text>;
}

describe("useConnection", () => {
  it("seeds connected from the client and flips false on disconnect", () => {
    const client = createMockClient();
    const { lastFrame } = render(<Probe client={client} />);
    expect(lastFrame()).toContain("ONLINE");

    act(() => {
      client.emit("disconnect");
    });
    expect(lastFrame()).toContain("OFFLINE");
  });

  it("flips false on session.destroyed", () => {
    const client = createMockClient();
    const { lastFrame } = render(<Probe client={client} />);

    act(() => {
      client.emit("session.destroyed");
    });
    expect(lastFrame()).toContain("OFFLINE");
  });

  it("retry re-invokes client.connect() and marks connected again", () => {
    const client = createMockClient();
    const { lastFrame } = render(<Probe client={client} />);

    act(() => {
      client.emit("disconnect");
    });
    expect(lastFrame()).toContain("OFFLINE");

    act(() => {
      captured?.retry();
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("ONLINE");
  });

  it("unsubscribes its listeners on unmount", () => {
    const client = createMockClient();
    const { unmount } = render(<Probe client={client} />);
    expect(client.listenerCount("disconnect")).toBe(1);
    expect(client.listenerCount("session.destroyed")).toBe(1);
    unmount();
    expect(client.listenerCount("disconnect")).toBe(0);
    expect(client.listenerCount("session.destroyed")).toBe(0);
  });
});
