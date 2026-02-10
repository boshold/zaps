import { EventEmitter } from "node:events";

import type { ServiceManager } from "../../src/lib/service/manager.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

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
    startService: vi.fn().mockResolvedValue(null),
    stopService: vi.fn().mockResolvedValue(null),
    restartService: vi.fn().mockResolvedValue(null),
    startAll: vi.fn().mockResolvedValue(null),
    stopAll: vi.fn().mockResolvedValue(null),
  });

  return manager as unknown as ServiceManager;
}

function makeStatus(name: string, state: ServiceStatus["state"] = "stopped"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

function renderActions(manager: ServiceManager) {
  let actionsRef: ReturnType<typeof useServiceActions> | null = null;

  function Wrapper() {
    actionsRef = useServiceActions(manager);
    return <Text>ok</Text>;
  }

  render(<Wrapper />);
  return actionsRef!; // eslint-disable-line typescript-eslint/no-non-null-assertion -- Set synchronously by render
}

describe("useServiceActions", () => {
  it("toggle: calls stopService when state is ready", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "ready"),
    });

    const actions = renderActions(manager);
    await actions.toggle("api");
    expect(vi.mocked(manager.stopService)).toHaveBeenCalledWith("api");
    expect(vi.mocked(manager.startService)).not.toHaveBeenCalled();
  });

  it("toggle: calls stopService when state is starting", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "starting"),
    });

    const actions = renderActions(manager);
    await actions.toggle("api");
    expect(vi.mocked(manager.stopService)).toHaveBeenCalledWith("api");
  });

  it("toggle: calls startService when state is stopped", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "stopped"),
    });

    const actions = renderActions(manager);
    await actions.toggle("api");
    expect(vi.mocked(manager.startService)).toHaveBeenCalledWith("api");
    expect(vi.mocked(manager.stopService)).not.toHaveBeenCalled();
  });

  it("toggle: calls startService when state is error", async () => {
    const manager = createMockManager({
      api: makeStatus("api", "error"),
    });

    const actions = renderActions(manager);
    await actions.toggle("api");
    expect(vi.mocked(manager.startService)).toHaveBeenCalledWith("api");
  });

  it("restart calls manager.restartService", async () => {
    const manager = createMockManager({
      db: makeStatus("db", "ready"),
    });

    const actions = renderActions(manager);
    await actions.restart("db");
    expect(vi.mocked(manager.restartService)).toHaveBeenCalledWith("db");
  });

  it("restartAll calls stopAll then startAll", async () => {
    const manager = createMockManager({
      db: makeStatus("db", "ready"),
    });

    const actions = renderActions(manager);
    await actions.restartAll();
    expect(vi.mocked(manager.stopAll)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(manager.startAll)).toHaveBeenCalledTimes(1);
  });
});
