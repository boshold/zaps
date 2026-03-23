import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { useServices } from "../../src/hooks/useServices.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function createMockClient(statuses: ServiceStatus[] = []): DaemonClient {
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
    listServices: vi.fn().mockResolvedValue([...statuses]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
  });
  return client as unknown as DaemonClient;
}

function makeStatus(name: string, state: ServiceStatus["state"] = "stopped"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

describe("useServices", () => {
  it("returns initial statuses on first render", () => {
    const initial = [makeStatus("db", "ready"), makeStatus("api", "starting")];
    const client = createMockClient(initial);

    function TestWrapper() {
      const statuses = useServices(client, initial);
      return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
    }

    const { lastFrame } = render(<TestWrapper />);
    expect(lastFrame()).toContain("db:ready");
    expect(lastFrame()).toContain("api:starting");
  });

  it("updates state on client service.stateChange event", async () => {
    const initial = [makeStatus("db", "stopped"), makeStatus("api", "stopped")];
    const client = createMockClient(initial);

    function TestWrapper() {
      const statuses = useServices(client, initial);
      return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
    }

    const { lastFrame } = render(<TestWrapper />);
    expect(lastFrame()).toContain("db:stopped");

    // Emit state change event
    const updated = makeStatus("db", "ready");
    act(() => {
      client.emit("service.stateChange", "db", updated);
    });

    expect(lastFrame()).toContain("db:ready");
    expect(lastFrame()).toContain("api:stopped");
  });

  it("resets statuses on session.configReloaded event", async () => {
    const initial = [makeStatus("db", "ready"), makeStatus("api", "ready")];
    const client = createMockClient(initial);

    function TestWrapper() {
      const statuses = useServices(client, initial);
      return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
    }

    const { lastFrame } = render(<TestWrapper />);
    expect(lastFrame()).toContain("db:ready");

    // Emit config reload with new service set
    const newStatuses = [makeStatus("web", "stopped"), makeStatus("worker", "stopped")];
    act(() => {
      client.emit("session.configReloaded", { statuses: newStatuses });
    });

    expect(lastFrame()).toContain("web:stopped");
    expect(lastFrame()).toContain("worker:stopped");
    expect(lastFrame()).not.toContain("db");
  });

  it("cleans up event listener on unmount", () => {
    const initial = [makeStatus("db")];
    const client = createMockClient(initial);

    function TestWrapper() {
      const statuses = useServices(client, initial);
      return <Text>{statuses.length.toString()}</Text>;
    }

    const { unmount } = render(<TestWrapper />);
    expect(client.listenerCount("service.stateChange")).toBe(1);

    unmount();
    expect(client.listenerCount("service.stateChange")).toBe(0);
  });
});
