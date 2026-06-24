import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { usePaneMap } from "../../src/hooks/usePaneMap.js";

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    session: "test",
  });
  return client as unknown as DaemonClient;
}

function renderPaneMap(client: DaemonClient, initial: Record<string, string>) {
  function TestWrapper() {
    const paneMap = usePaneMap(client, initial);
    return (
      <Text>
        {Object.entries(paneMap)
          .map(([name, id]) => `${name}=${id}`)
          .join(",")}
      </Text>
    );
  }
  return render(<TestWrapper />);
}

describe("usePaneMap", () => {
  it("returns the initial snapshot on first render", () => {
    const client = createMockClient();
    const { lastFrame } = renderPaneMap(client, { "@tui": "%1", nuxt: "%2" });
    expect(lastFrame()).toContain("@tui=%1");
    expect(lastFrame()).toContain("nuxt=%2");
  });

  it("updates wholesale on a session.paneMap event (lazy pane inserted)", () => {
    const client = createMockClient();
    const { lastFrame } = renderPaneMap(client, { "@tui": "%1" });
    expect(lastFrame()).not.toContain("rainfrog");

    act(() => {
      client.emit("session.paneMap", { "@tui": "%1", rainfrog: "%9" });
    });

    expect(lastFrame()).toContain("rainfrog=%9");
  });

  it("drops a pane when session.paneMap omits it (lazy pane removed)", () => {
    const client = createMockClient();
    const { lastFrame } = renderPaneMap(client, { "@tui": "%1", rainfrog: "%9" });
    expect(lastFrame()).toContain("rainfrog=%9");

    act(() => {
      client.emit("session.paneMap", { "@tui": "%1" });
    });

    expect(lastFrame()).not.toContain("rainfrog");
  });

  it("refreshes from the snapshot on session.configReloaded", () => {
    const client = createMockClient();
    const { lastFrame } = renderPaneMap(client, { "@tui": "%1", old: "%2" });

    act(() => {
      client.emit("session.configReloaded", { paneMap: { "@tui": "%1", web: "%5" } });
    });

    expect(lastFrame()).toContain("web=%5");
    expect(lastFrame()).not.toContain("old");
  });

  it("cleans up listeners on unmount", () => {
    const client = createMockClient();
    const { unmount } = renderPaneMap(client, {});
    expect(client.listenerCount("session.paneMap")).toBe(1);
    expect(client.listenerCount("session.configReloaded")).toBe(1);

    unmount();
    expect(client.listenerCount("session.paneMap")).toBe(0);
    expect(client.listenerCount("session.configReloaded")).toBe(0);
  });
});
