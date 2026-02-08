import { EventEmitter } from "node:events";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ServiceStatus } from "../../src/lib/service/types.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";
import { useServiceActions } from "../../src/hooks/useServiceActions.js";

function createMockManager(statuses: Record<string, ServiceStatus>): ServiceManager {
  const emitter = new EventEmitter();

  const manager = Object.assign(emitter, {
    getAllStatuses: vi.fn(() => Object.values(statuses)),
    getStatus: vi.fn((name: string) => {
      const s = statuses[name];
      if (!s) {
        throw new Error(`Unknown service: ${name}`);
      }
      return s;
    }),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
  });

  return manager as unknown as ServiceManager;
}

function makeStatus(name: string, state: ServiceStatus["state"] = "stopped"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

describe("useServiceActions", () => {
  it("toggle: calls stopService when state is ready", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "ready"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.toggle("api");
    expect(manager.stopService).toHaveBeenCalledWith("api");
    expect(manager.startService).not.toHaveBeenCalled();
  });

  it("toggle: calls stopService when state is starting", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "starting"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.toggle("api");
    expect(manager.stopService).toHaveBeenCalledWith("api");
  });

  it("toggle: calls startService when state is stopped", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "stopped"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.toggle("api");
    expect(manager.startService).toHaveBeenCalledWith("api");
    expect(manager.stopService).not.toHaveBeenCalled();
  });

  it("toggle: calls startService when state is error", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "error"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.toggle("api");
    expect(manager.startService).toHaveBeenCalledWith("api");
  });

  it("restart calls manager.restartService", async () => {
    const manager = createMockManager({
      db: makeStatus("db", "ready"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.restart("db");
    expect(manager.restartService).toHaveBeenCalledWith("db");
  });

  it("restartAll calls stopAll then startAll", async () => {
    const manager = createMockManager({
      db: makeStatus("db", "ready"),
    });

    let actionsRef: ReturnType<typeof useServiceActions> | null = null;

    function Wrapper() {
      actionsRef = useServiceActions(manager);
      return <Text>ok</Text>;
    }

    render(<Wrapper />);

    await actionsRef!.restartAll();
    expect(manager.stopAll).toHaveBeenCalledTimes(1);
    expect(manager.startAll).toHaveBeenCalledTimes(1);
  });
});
