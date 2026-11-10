import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import type { Connection } from "../../src/hooks/useConnection.js";
import { useConnection } from "../../src/hooks/useConnection.js";
import { deferred } from "../_helpers/deferred.js";
import { makeSessionSnapshot } from "../_helpers/session-snapshot.js";

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connectUi: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    uiBound: true,
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

  it("waits for the full retry handshake and stays offline on failure", async () => {
    const client = createMockClient();
    const first = deferred<Awaited<ReturnType<DaemonClient["connectUi"]>>>();
    const second = deferred<Awaited<ReturnType<DaemonClient["connectUi"]>>>();
    vi.mocked(client.connectUi)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { lastFrame } = render(<Probe client={client} />);

    act(() => {
      client.emit("disconnect");
    });
    act(() => captured?.retry());
    expect(client.connectUi).toHaveBeenCalledOnce();
    expect(lastFrame()).toContain("OFFLINE");

    await act(async () => {
      first.reject(new Error("attach failed"));
    });
    expect(lastFrame()).toContain("OFFLINE");
    act(() => captured?.retry());
    expect(lastFrame()).toContain("OFFLINE");
    await act(async () => {
      second.resolve(makeSessionSnapshot());
    });
    expect(lastFrame()).toContain("ONLINE");
  });

  it("ignores a superseded retry and cancels the pending retry on unmount", async () => {
    const client = createMockClient();
    const stale = deferred<Awaited<ReturnType<DaemonClient["connectUi"]>>>();
    const pending = deferred<Awaited<ReturnType<DaemonClient["connectUi"]>>>();
    vi.mocked(client.connectUi)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(pending.promise);
    const { lastFrame, unmount } = render(<Probe client={client} />);
    act(() => captured?.retry());
    act(() => captured?.retry());
    await act(async () => {
      stale.resolve(makeSessionSnapshot());
    });
    expect(lastFrame()).toContain("OFFLINE");
    unmount();
    expect(client.disconnect).toHaveBeenCalledOnce();
    pending.reject(new Error("closed"));
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
