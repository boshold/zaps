/* eslint-disable typescript-eslint/unbound-method -- Mock method assertions */
/* eslint-disable typescript-eslint/no-non-null-assertion -- Promise resolve refs */
import { EventEmitter } from "node:events";

import type { ResolvedConfig } from "../src/config/types.js";
import type { ServiceManager } from "../src/lib/service/manager.js";
import type { ServiceStatus } from "../src/lib/service/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Mock tmux.capturePane to avoid real tmux calls in logs view tests
vi.mock("../src/lib/tmux.js", () => ({
  capturePane: vi.fn().mockResolvedValue(""),
}));

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
// Const RETURN = "\r"; // Available for future task execution tests

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

function createMockManager(statuses: ServiceStatus[] = []): ServiceManager {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    getAllStatuses: vi.fn(() => [...statuses]),
    getStatus: vi.fn((name: string) => {
      const s = statuses.find((st) => st.name === name);
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

describe("App", () => {
  it("renders dashboard with project name", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig("my-app");

    const { lastFrame } = render(<App manager={manager} config={config} paneMap={{}} />);

    expect(lastFrame()).toContain("zaps");
    expect(lastFrame()).toContain("my-app");
  });

  it("initial view is dashboard", () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { lastFrame } = render(<App manager={manager} config={config} paneMap={{}} />);

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
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

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
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("r");
    });
    await act();

    expect(vi.mocked(manager.restartService)).toHaveBeenCalledWith("db");
  });

  it("s triggers toggle on selected service", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("s");
    });
    await act();

    // Toggle on a ready service calls stopService
    expect(vi.mocked(manager.stopService)).toHaveBeenCalledWith("db");
  });

  it("a calls restartAll", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("a");
    });
    await act();

    expect(vi.mocked(manager.stopAll)).toHaveBeenCalled();
    expect(vi.mocked(manager.startAll)).toHaveBeenCalled();
  });

  it("q calls stopAll + exit", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("q");
    });
    await act();

    expect(vi.mocked(manager.stopAll)).toHaveBeenCalled();
  });

  it("o with no url is a no-op", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { stdin, lastFrame } = render(<App manager={manager} config={config} paneMap={{}} />);

    // Should not throw
    await act(() => {
      stdin.write("o");
    });
    expect(lastFrame()).toContain("db");
  });
});

describe("Keyboard routing — View switching", () => {
  it("t switches to tasks view", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig("test", {
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });

    const { lastFrame, stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("t");
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
    expect(frame).toContain("Run migrations");
  });

  it("Esc from tasks returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig("test", {
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });

    const { lastFrame, stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    // Go to tasks
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
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App manager={manager} config={config} paneMap={{ db: "%0", api: "%1" }} />,
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
    expect(frame).toContain("[esc] back");
  });

  it("Esc from logs returns to dashboard", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];
    const manager = createMockManager(statuses);
    const config = makeConfig();

    const { lastFrame, stdin } = render(
      <App manager={manager} config={config} paneMap={{ db: "%0" }} />,
    );

    // Go to logs
    await act(() => {
      stdin.write("l");
    });
    expect(lastFrame()).toContain("[esc] back");

    // Go back
    await act(() => {
      stdin.write(ESCAPE);
    });
    expect(lastFrame()).toContain("[t]asks");
  });
});

describe("Keyboard routing — Edge cases", () => {
  it("no services — arrow keys are no-ops", async () => {
    const manager = createMockManager([]);
    const config = makeConfig();

    const { lastFrame, stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

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
    const manager = createMockManager([]);
    const config = makeConfig();

    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("s");
    });
    await act();

    expect(vi.mocked(manager.restartService)).not.toHaveBeenCalled();
    expect(vi.mocked(manager.stopService)).not.toHaveBeenCalled();
    expect(vi.mocked(manager.startService)).not.toHaveBeenCalled();
  });

  it("rapid key presses do not cause race conditions", async () => {
    const statuses: ServiceStatus[] = [
      { name: "db", state: "ready", ports: [5432], retryCount: 0 },
    ];

    // Make restartService take time
    // eslint-disable-next-line init-declarations -- Initialized inside Promise constructor
    let resolveRestart!: () => void;
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });

    const manager = createMockManager(statuses);
    vi.mocked(manager.restartService).mockReturnValue(restartPromise);

    const config = makeConfig();
    const { stdin } = render(<App manager={manager} config={config} paneMap={{}} />);

    // Press r twice rapidly
    await act(() => {
      stdin.write("r");
    });
    await act(() => {
      stdin.write("r");
    });

    // Should only have been called once (busyRef guards)
    expect(vi.mocked(manager.restartService)).toHaveBeenCalledTimes(1);

    // Resolve to clean up
    resolveRestart();
    await act();
  });
});
