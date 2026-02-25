/* eslint-disable typescript-eslint/unbound-method -- Mock method assertions */
import { EventEmitter } from "node:events";

import type { DaemonClient } from "../src/client/daemon-client.js";
import type { ResolvedConfig } from "../src/config/types.js";
import type { ServiceStatus } from "../src/lib/service/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/components/App.js";

// Flush React/Ink reconciler
async function act(fn?: () => void): Promise<void> {
  if (fn) {
    fn();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

// ANSI escape sequences for special keys
const ARROW_UP = "\x1B[A";
const ARROW_DOWN = "\x1B[B";
const ESCAPE = "\x1B";

function makeConfig(
  name = "test-project",
  tasks?: ResolvedConfig["project"]["tasks"],
): ResolvedConfig {
  return {
    project: { name, services: {}, tasks },
    configPath: "/fake/.zaps.ts",
    projectDir: "/fake",
  };
}

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

describe("App", () => {
  it("renders dashboard with project name", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig("my-app");

    const { lastFrame } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    expect(lastFrame()).toContain("zaps");
    expect(lastFrame()).toContain("my-app");
  });

  it("initial view is dashboard", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { lastFrame } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[q]uit");
  });
});

describe("Keyboard routing — Dashboard", () => {
  it("up/down changes selection index", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    // Move down — api should be selected
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    const frame = lastFrame() ?? "";
    // ">" appears before the selected service
    const lines = frame.split("\n");
    const apiLine = lines.find((l) => l.includes("api"));
    expect(apiLine).toContain(">");
  });

  it("r triggers restart on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("r");
    });
    await act();

    expect(vi.mocked(client.restartService)).toHaveBeenCalledWith("db");
  });

  it("s triggers toggle on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("s");
    });
    await act();

    // Toggle tries stopService first (succeeds for running service)
    expect(vi.mocked(client.stopService)).toHaveBeenCalledWith("db");
  });

  it("a calls restartAll", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("a");
    });
    await act();

    expect(vi.mocked(client.listServices)).toHaveBeenCalled();
    expect(vi.mocked(client.restartService)).toHaveBeenCalledWith("db");
  });

  it("q disconnects and exits", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("q");
    });
    await act();

    expect(vi.mocked(client.disconnect)).toHaveBeenCalled();
  });

  it("o with no url is a no-op", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { stdin, lastFrame } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    // Should not throw
    await act(() => {
      stdin.write("o");
    });
    expect(lastFrame()).toContain("db");
  });
});

describe("Keyboard routing — View switching", () => {
  it("t goes directly to tasks view with shortcuts inline", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig("test", {
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });

    const { lastFrame, stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("t");
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
    expect(frame).toContain("[m]");
    expect(frame).toContain("Run migrations");
  });

  it("Esc from tasks returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig("test", {
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });

    const { lastFrame, stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    await act(() => {
      stdin.write("t");
    });
    expect(lastFrame()).toContain("Tasks");

    // Go back
    await act(() => {
      stdin.write(ESCAPE);
    });
    expect(lastFrame()).toContain("[t]asks");
  });

  it("l switches to logs view with correct target", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App
        client={client}
        config={config}
        paneMap={{ db: "%0", api: "%1" }}
        initialStatuses={statuses}
      />,
    );

    // Select api (index 1) then press l
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    await act(() => {
      stdin.write("l");
    });

    const frame = lastFrame() ?? "";
    // LogView shows service name in header
    expect(frame).toContain("api");
    expect(frame).toContain("[q/esc] back");
  });

  it("Esc from logs returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const client = createMockClient(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App client={client} config={config} paneMap={{ db: "%0" }} initialStatuses={statuses} />,
    );

    // Go to logs
    await act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[q/esc] back");

    // Go back
    await act(() => {
      stdin.write(ESCAPE);
    });
    expect(lastFrame()).toContain("[t]asks");
  });
});

describe("Keyboard routing — Edge cases", () => {
  it("no services — arrow keys are no-ops", async () => {
    const client = createMockClient([]);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={[]} />,
    );

    // Should not throw
    await act(() => {
      stdin.write(ARROW_UP);
    });
    await act(() => {
      stdin.write(ARROW_DOWN);
    });
    expect(lastFrame()).toContain("zaps");
  });

  it("r/s with no services is a no-op", async () => {
    const client = createMockClient([]);
    const config = makeConfig();

    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={[]} />,
    );

    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("s");
    });
    await act();

    expect(vi.mocked(client.restartService)).not.toHaveBeenCalled();
    expect(vi.mocked(client.stopService)).not.toHaveBeenCalled();
    expect(vi.mocked(client.startService)).not.toHaveBeenCalled();
  });

  it("rapid key presses do not cause race conditions", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    // Make restartService take time
    let resolveRestart!: () => void;
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });

    const client = createMockClient(statuses);
    vi.mocked(client.restartService).mockReturnValue(restartPromise);

    const config = makeConfig();
    const { stdin } = render(
      <App client={client} config={config} paneMap={{}} initialStatuses={statuses} />,
    );

    // Press r twice rapidly
    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("r");
    });

    // Should only have been called once (busyRef guards)
    expect(vi.mocked(client.restartService)).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    resolveRestart();
    await act();
  });
});
