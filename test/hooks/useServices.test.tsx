import { EventEmitter } from "node:events";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ServiceStatus } from "../../src/lib/service/types.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";
import { useServices } from "../../src/hooks/useServices.js";

// Minimal act()
function act(fn: () => void): Promise<void> {
  return new Promise((resolve) => {
    fn();
    setTimeout(resolve, 0);
  });
}

// Create a mock ServiceManager that extends EventEmitter
function createMockManager(initialStatuses: ServiceStatus[]): ServiceManager {
  const emitter = new EventEmitter();
  let statuses = [...initialStatuses];

  const manager = Object.assign(emitter, {
    getAllStatuses: vi.fn(() => [...statuses]),
    getStatus: vi.fn((name: string) => {
      const s = statuses.find((st) => st.name === name);
      if (!s) {
        throw new Error(`Unknown service: ${name}`);
      }
      return s;
    }),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    // Expose a helper to update statuses for testing
    _setStatuses(newStatuses: ServiceStatus[]) {
      statuses = [...newStatuses];
    },
  });

  return manager as unknown as ServiceManager;
}

function makeStatus(name: string, state: ServiceStatus["state"] = "stopped"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

describe("useServices", () => {
  it("returns current statuses on initial render", () => {
    const manager = createMockManager([
      makeStatus("db", "ready"),
      makeStatus("api", "starting"),
    ]);

    function Wrapper() {
      const statuses = useServices(manager);
      return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("db:ready");
    expect(lastFrame()).toContain("api:starting");
  });

  it("updates state on manager stateChange event", async () => {
    const initial = [makeStatus("db", "stopped"), makeStatus("api", "stopped")];
    const manager = createMockManager(initial);

    function Wrapper() {
      const statuses = useServices(manager);
      return <Text>{statuses.map((s) => `${s.name}:${s.state}`).join(",")}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("db:stopped");

    // Update the underlying statuses and emit event
    const updated = [makeStatus("db", "ready"), makeStatus("api", "stopped")];
    (manager as unknown as { _setStatuses: (s: ServiceStatus[]) => void })._setStatuses(updated);

    await act(() => {
      manager.emit("stateChange", "db", updated[0]);
    });

    expect(lastFrame()).toContain("db:ready");
    expect(lastFrame()).toContain("api:stopped");
  });

  it("cleans up event listener on unmount", () => {
    const manager = createMockManager([makeStatus("db")]);

    function Wrapper() {
      const statuses = useServices(manager);
      return <Text>{statuses.length.toString()}</Text>;
    }

    const { unmount } = render(<Wrapper />);
    expect(manager.listenerCount("stateChange")).toBe(1);

    unmount();
    expect(manager.listenerCount("stateChange")).toBe(0);
  });
});
