import { EventEmitter } from "node:events";

import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { useServiceActions } from "../../src/hooks/useServiceActions.js";
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
    restartAll: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
  });
  return client as unknown as DaemonClient;
}

function makeStatus(name: string, state: ServiceStatus["state"] = "stopped"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

function renderActions(client: DaemonClient) {
  let actionsRef: ReturnType<typeof useServiceActions> | null = null;

  function Wrapper() {
    actionsRef = useServiceActions(client);
    return <Text>ok</Text>;
  }

  render(<Wrapper />);
  return actionsRef!;
}

describe("useServiceActions", () => {
  it("toggle: calls stopService when service is running", async () => {
    const client = createMockClient([makeStatus("api", "ready")]);

    const actions = renderActions(client);
    await actions.toggle("api");
    expect(vi.mocked(client.stopService)).toHaveBeenCalledWith("api");
    expect(vi.mocked(client.startService)).not.toHaveBeenCalled();
  });

  it("toggle: calls startService when service is stopped", async () => {
    const client = createMockClient([makeStatus("api", "stopped")]);

    const actions = renderActions(client);
    await actions.toggle("api");
    expect(vi.mocked(client.stopService)).not.toHaveBeenCalled();
    expect(vi.mocked(client.startService)).toHaveBeenCalledWith("api");
  });

  it("restart calls client.restartService", async () => {
    const client = createMockClient([makeStatus("db", "ready")]);

    const actions = renderActions(client);
    await actions.restart("db");
    expect(vi.mocked(client.restartService)).toHaveBeenCalledWith("db");
  });

  it("restartAll calls client.restartAll", async () => {
    const statuses = [makeStatus("db", "ready"), makeStatus("api", "ready")];
    const client = createMockClient(statuses);

    const actions = renderActions(client);
    await actions.restartAll();
    expect(vi.mocked(client.restartAll)).toHaveBeenCalledTimes(1);
  });

  it("rebuildDocker does not throw", async () => {
    const client = createMockClient([makeStatus("db", "ready")]);

    const actions = renderActions(client);
    await expect(
      actions.rebuildDocker("db", { build: true, forceRecreate: true }),
    ).resolves.not.toThrow();
  });
});
