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

  // ── poll epoch guard (F9) ────────────────────────────────────

  it("discards a poll response that started before a newer event-driven update (F9)", async () => {
    vi.useFakeTimers();
    try {
      const initial = [makeStatus("db", "starting")];
      const client = createMockClient(initial);

      // Hold the poll response open so an event can land while it is in flight.
      let resolvePoll: (v: ServiceStatus[]) => void = () => {
        /* Replaced below once the pending poll promise exists */
      };
      const pendingPoll = new Promise<ServiceStatus[]>((resolve) => {
        resolvePoll = resolve;
      });
      client.listServices = vi.fn(async () => pendingPoll);

      function TestWrapper() {
        const statuses = useServices(client, initial);
        return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
      }

      const { lastFrame } = render(<TestWrapper />);
      expect(lastFrame()).toContain("db:starting");

      // Fire the 2s poll; it captures epoch 0 and awaits the pending listServices.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      // A fresher event-driven update lands first and bumps the epoch.
      act(() => {
        client.emit("service.stateChange", "db", makeStatus("db", "ready"));
      });
      expect(lastFrame()).toContain("db:ready");

      // The stale poll finally resolves — it must be discarded, not applied.
      await act(async () => {
        resolvePoll([makeStatus("db", "starting")]);
        await Promise.resolve();
      });

      expect(lastFrame()).toContain("db:ready");
      expect(lastFrame()).not.toContain("db:starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a poll response when no event raced ahead of it (F9 control)", async () => {
    vi.useFakeTimers();
    try {
      const initial = [makeStatus("db", "starting")];
      const client = createMockClient(initial);
      client.listServices = vi.fn().mockResolvedValue([makeStatus("db", "ready")]);

      function TestWrapper() {
        const statuses = useServices(client, initial);
        return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
      }

      const { lastFrame } = render(<TestWrapper />);
      expect(lastFrame()).toContain("db:starting");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(lastFrame()).toContain("db:ready");
    } finally {
      vi.useRealTimers();
    }
  });
});
