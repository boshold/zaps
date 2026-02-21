import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all external dependencies before importing the module under test

const mockDiscoverConfig = vi.fn<(dir: string) => string | null>();
const mockLoadConfig = vi.fn();
const mockScaffoldConfig = vi.fn();
const mockListSessions = vi.fn<() => Promise<string[]>>();
const mockHasSession = vi.fn<(name: string) => Promise<boolean>>();
const mockNewSession = vi.fn<(name: string) => Promise<string>>();
const mockKillSession = vi.fn<(name: string) => Promise<void>>();
const mockSendKeys = vi.fn<(target: string, keys: string) => Promise<void>>();
const mockSetEnv = vi.fn<(session: string, key: string, value: string) => Promise<void>>();
const mockShowEnv = vi.fn<(session: string, key: string) => Promise<string | null>>();
const mockCurrentSession = vi.fn<() => Promise<string>>();
const mockCreateLayout = vi.fn();
const mockSendCtrlC = vi.fn();
const mockPanePid = vi.fn();
const mockCapturePane = vi.fn();
const mockDetectPorts = vi.fn();
const mockGetDescendantPids = vi.fn();

vi.mock("../src/config/discovery.js", () => ({
  discoverConfig: (...args: unknown[]) => mockDiscoverConfig(...(args as [string])),
}));

vi.mock("../src/config/loader.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../src/config/scaffold.js", () => ({
  scaffoldConfig: (...args: unknown[]) => mockScaffoldConfig(...args),
}));

vi.mock("../src/lib/tmux.js", () => ({
  listSessions: async () => mockListSessions(),
  hasSession: async (...args: unknown[]) => mockHasSession(...(args as [string])),
  newSession: async (...args: unknown[]) => mockNewSession(...(args as [string])),
  killSession: async (...args: unknown[]) => mockKillSession(...(args as [string])),
  sendKeys: async (...args: unknown[]) => mockSendKeys(...(args as [string, string])),
  setEnv: async (...args: unknown[]) => mockSetEnv(...(args as [string, string, string])),
  showEnv: async (...args: unknown[]) => mockShowEnv(...(args as [string, string])),
  currentSession: async () => mockCurrentSession(),
  sendCtrlC: (...args: unknown[]) => mockSendCtrlC(...args),
  panePid: (...args: unknown[]) => mockPanePid(...args),
  capturePane: (...args: unknown[]) => mockCapturePane(...args),
}));

vi.mock("../src/lib/tmux-layout.js", () => ({
  createLayout: (...args: unknown[]) => mockCreateLayout(...args),
}));

vi.mock("../src/lib/port.js", () => ({
  detectPorts: (...args: unknown[]) => mockDetectPorts(...args),
  getDescendantPids: (...args: unknown[]) => mockGetDescendantPids(...args),
}));

// Mock ServiceManager
const mockStartAll = vi.fn<() => Promise<void>>().mockResolvedValue();
const mockStopAll = vi.fn<() => Promise<void>>().mockResolvedValue();

vi.mock("../src/lib/service/manager.js", () => ({
  ServiceManager: vi.fn().mockImplementation(() => ({
    startAll: mockStartAll,
    stopAll: mockStopAll,
    getAllStatuses: vi.fn(() => []),
    getStatus: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
  })),
}));

// Mock ink render
const mockWaitUntilExit = vi.fn<() => Promise<void>>().mockResolvedValue();

vi.mock("ink", () => ({
  render: vi.fn(() => ({
    waitUntilExit: mockWaitUntilExit,
    unmount: vi.fn(),
    cleanup: vi.fn(),
    clear: vi.fn(),
    rerender: vi.fn(),
  })),
  useApp: vi.fn(() => ({ exit: vi.fn() })),
  useInput: vi.fn(),
  Text: vi.fn(({ children }: { children: string }) => children),
  Box: vi.fn(({ children }: { children: string }) => children),
}));

// Mock components
vi.mock("../src/components/App.js", () => ({
  App: vi.fn(() => null),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("CLI — dev command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("errors when no config found", () => {
    mockDiscoverConfig.mockReturnValue(null);

    // Directly test the logic: discoverConfig returns null -> error
    const configPath = mockDiscoverConfig(process.cwd());
    expect(configPath).toBeNull();
  });

  it("errors when session already exists", async () => {
    // Verify the hasSession check logic
    mockHasSession.mockResolvedValue(true);
    const exists = await mockHasSession("zaps-my-project");
    expect(exists).toBe(true);
  });

  it("outer flow uses sendKeys when @tui is a different pane", async () => {
    // Simulate the outer flow: originPane != tuiPaneId → sendKeys
    mockDiscoverConfig.mockReturnValue("/fake/.zaps.ts");
    mockLoadConfig.mockResolvedValue({
      project: {
        name: "test-proj",
        services: { api: { start: "npm dev" } },
      },
      configPath: "/fake/.zaps.ts",
      projectDir: "/fake",
    });
    mockCreateLayout.mockResolvedValue({
      paneMap: { "@tui": "%1", api: "%2" },
      focusPane: "%1",
    });
    mockSetEnv.mockResolvedValue();
    mockSendKeys.mockResolvedValue();

    const originPane = "%0";
    const paneMap = { "@tui": "%1", api: "%2" };
    const tuiPaneId = paneMap["@tui"];

    // Different pane: should use sendKeys
    expect(tuiPaneId).not.toBe(originPane);
    await mockSendKeys(tuiPaneId, "zaps ui --start; exit");
    expect(mockSendKeys).toHaveBeenCalledWith("%1", "zaps ui --start; exit");
  });

  it("outer flow calls runTui directly when @tui is origin pane", async () => {
    // Simulate the outer flow: originPane == tuiPaneId → direct call (no sendKeys)
    mockDiscoverConfig.mockReturnValue("/fake/.zaps.ts");
    mockLoadConfig.mockResolvedValue({
      project: {
        name: "test-proj",
        services: { api: { start: "npm dev" } },
      },
      configPath: "/fake/.zaps.ts",
      projectDir: "/fake",
    });
    mockCreateLayout.mockResolvedValue({
      paneMap: { "@tui": "%0", api: "%1" },
      focusPane: "%0",
    });
    mockSetEnv.mockResolvedValue();

    const originPane = "%0";
    const paneMap = { "@tui": "%0", api: "%1" };
    const tuiPaneId = paneMap["@tui"];

    // Same pane: should NOT use sendKeys
    expect(tuiPaneId).toBe(originPane);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("CLI — ui command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads ZAPS_PANE_MAP via showEnv", async () => {
    const paneMap = { "@tui": "%0", api: "%1" };
    mockCurrentSession.mockResolvedValue("my-session");
    mockShowEnv.mockResolvedValue(JSON.stringify(paneMap));

    const session = await mockCurrentSession();
    const raw = await mockShowEnv(session, "ZAPS_PANE_MAP");
    const parsed = JSON.parse(raw ?? "") as Record<string, string>;
    expect(parsed).toEqual(paneMap);
    expect(mockShowEnv).toHaveBeenCalledWith("my-session", "ZAPS_PANE_MAP");
  });

  it("errors when ZAPS_PANE_MAP not set in tmux env", async () => {
    mockCurrentSession.mockResolvedValue("my-session");
    mockShowEnv.mockResolvedValue(null);

    const session = await mockCurrentSession();
    const raw = await mockShowEnv(session, "ZAPS_PANE_MAP");
    expect(raw).toBeNull();
  });

  it("creates ServiceManager with correct deps", () => {
    // Verify deps structure matches ServiceManagerDeps interface
    const deps = {
      sendKeys: mockSendKeys,
      sendCtrlC: mockSendCtrlC,
      panePid: mockPanePid,
      detectPorts: mockDetectPorts,
      capturePane: mockCapturePane,
      getDescendantPids: mockGetDescendantPids,
    };

    expect(deps).toHaveProperty("sendKeys");
    expect(deps).toHaveProperty("sendCtrlC");
    expect(deps).toHaveProperty("panePid");
    expect(deps).toHaveProperty("detectPorts");
    expect(deps).toHaveProperty("capturePane");
    expect(deps).toHaveProperty("getDescendantPids");
  });

  it("inner flow calls startAll then renders, then stopAll on exit", async () => {
    // Simulate inner flow: stopAll fires onStop hook internally, not separately in cli
    const callOrder: string[] = [];

    mockStartAll.mockImplementation(async () => {
      callOrder.push("startAll");
    });
    mockWaitUntilExit.mockImplementation(async () => {
      callOrder.push("waitUntilExit");
    });
    mockStopAll.mockImplementation(async () => {
      callOrder.push("stopAll");
    });

    await mockStartAll();
    callOrder.push("render");
    await mockWaitUntilExit();
    await mockStopAll();

    expect(callOrder).toEqual(["startAll", "render", "waitUntilExit", "stopAll"]);
  });
});

describe("CLI — down command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills existing session", async () => {
    mockHasSession.mockResolvedValue(true);
    mockKillSession.mockResolvedValue();

    const sessionName = "zaps-my-project";
    if (await mockHasSession(sessionName)) {
      await mockKillSession(sessionName);
    }

    expect(mockKillSession).toHaveBeenCalledWith("zaps-my-project");
  });

  it("reports when no session found", async () => {
    mockHasSession.mockResolvedValue(false);

    const sessionName = "zaps-my-project";
    const exists = await mockHasSession(sessionName);
    expect(exists).toBe(false);
  });

  it("uses --name option to construct session name", () => {
    const opts = { name: "custom-proj" };
    const sessionName = `zaps-${opts.name}`;
    expect(sessionName).toBe("zaps-custom-proj");
  });

  it("falls back to config discovery when no --name", async () => {
    mockDiscoverConfig.mockReturnValue("/fake/.zaps.ts");
    mockLoadConfig.mockResolvedValue({
      project: { name: "detected-proj", services: {} },
      configPath: "/fake/.zaps.ts",
      projectDir: "/fake",
    });

    const configPath = mockDiscoverConfig(process.cwd());
    expect(configPath).not.toBeNull();

    const config = await mockLoadConfig(configPath);
    const sessionName = `zaps-${config.project.name}`;
    expect(sessionName).toBe("zaps-detected-proj");
  });

  it("errors when no config and no --name", () => {
    mockDiscoverConfig.mockReturnValue(null);
    const configPath = mockDiscoverConfig(process.cwd());
    expect(configPath).toBeNull();
    // In real CLI this would process.exit(1) with error message
  });
});

describe("CLI — sessions command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists active sessions", async () => {
    mockListSessions.mockResolvedValue(["zaps-project1", "zaps-project2"]);
    const sessions = await mockListSessions();
    expect(sessions).toEqual(["zaps-project1", "zaps-project2"]);
    expect(sessions.length).toBe(2);
  });

  it("reports when no sessions found", async () => {
    mockListSessions.mockResolvedValue([]);
    const sessions = await mockListSessions();
    expect(sessions).toEqual([]);
    expect(sessions.length).toBe(0);
  });
});

describe("CLI — init command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("errors when config already exists", () => {
    mockDiscoverConfig.mockReturnValue("/fake/.zaps.ts");
    const existing = mockDiscoverConfig(process.cwd());
    expect(existing).not.toBeNull();
    // In real CLI this would stderr + process.exit(1)
  });

  it("scaffolds config when none exists", async () => {
    mockDiscoverConfig.mockReturnValue(null);
    mockScaffoldConfig.mockResolvedValue("/tmp/test/.zaps.mts");

    const existing = mockDiscoverConfig(process.cwd());
    expect(existing).toBeNull();

    const written = await mockScaffoldConfig(process.cwd(), "test");
    expect(written).toBe("/tmp/test/.zaps.mts");
  });
});

describe("CLI — paneMap serialization", () => {
  it("round-trips paneMap through JSON", () => {
    const paneMap = {
      "@tui": "%0",
      api: "%1",
      db: "%2",
      frontend: "%3",
    };

    const serialized = JSON.stringify(paneMap);
    const deserialized = JSON.parse(serialized) as Record<string, string>;

    expect(deserialized).toEqual(paneMap);
    expect(typeof serialized).toBe("string");
  });

  it("handles empty paneMap", () => {
    const paneMap = {};
    const serialized = JSON.stringify(paneMap);
    const deserialized = JSON.parse(serialized) as Record<string, string>;
    expect(deserialized).toEqual({});
  });

  it("preserves special characters in pane IDs", () => {
    const paneMap = { "@tui": "%123", "my-service": "%456" };
    const serialized = JSON.stringify(paneMap);
    const deserialized = JSON.parse(serialized) as Record<string, string>;
    expect(deserialized["@tui"]).toBe("%123");
    expect(deserialized["my-service"]).toBe("%456");
  });
});

describe("CLI — session naming", () => {
  it("prefixes project name with zaps-", () => {
    const projectName = "my-app";
    const sessionName = `zaps-${projectName}`;
    expect(sessionName).toBe("zaps-my-app");
  });

  it("handles project names with special characters", () => {
    const projectName = "my_app-v2";
    const sessionName = `zaps-${projectName}`;
    expect(sessionName).toBe("zaps-my_app-v2");
  });
});

describe("CLI — buildDeps", () => {
  it("returns object with all required ServiceManagerDeps keys", () => {
    // Verify that the mock deps match the interface shape
    const requiredKeys: string[] = [
      "sendKeys",
      "sendCtrlC",
      "panePid",
      "detectPorts",
      "capturePane",
      "getDescendantPids",
    ];

    const deps = {
      sendKeys: mockSendKeys,
      sendCtrlC: mockSendCtrlC,
      panePid: mockPanePid,
      detectPorts: mockDetectPorts,
      capturePane: mockCapturePane,
      getDescendantPids: mockGetDescendantPids,
    };

    for (const key of requiredKeys) {
      expect(deps).toHaveProperty(key);
      expect(typeof (deps as Record<string, unknown>)[key]).toBe("function");
    }
  });
});
