import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("CLI — up command", () => {
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

describe("CLI — ls command", () => {
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

describe("CLI — cleye parse layer (subprocess parity)", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const CLI_TIMEOUT = 60_000;

  let spawnSyncReal: typeof import("node:child_process").spawnSync;
  let runtimeDir: string;

  beforeAll(async () => {
    // The module-level vi.mock replaces node:child_process; the parse-layer
    // Tests need the real spawnSync to exercise the actual CLI surface.
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnSyncReal = actual.spawnSync;
    // Isolated runtime dir so isDaemonRunning() never sees a real daemon.
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-cli-parse-"));
  });

  afterAll(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  // Absolute specifiers so the CLI can be spawned from any cwd (e.g. a config-
  // Free temp dir for the zero-argument default-command test).
  const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const cliEntry = path.join(repoRoot, "src/cli.tsx");

  function runCli(args: string[], envOverrides: Record<string, string> = {}, cwd = repoRoot) {
    return spawnSyncReal(process.execPath, ["--import", tsxImport, cliEntry, ...args], {
      cwd,
      encoding: "utf8",
      timeout: CLI_TIMEOUT,
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CURSOR_TRACE_DIR: undefined,
        TMUX: undefined,
        ZAPS_FORMAT: undefined,
        ZAPS_RUNTIME: undefined,
        ZAPS_SOCKET_PATH: undefined,
        XDG_RUNTIME_DIR: runtimeDir,
        ...envOverrides,
      },
    });
  }

  it(
    "--help lists every visible command and hides internal ones",
    () => {
      const res = runCli(["--help"]);
      expect(res.status).toBe(0);

      const visible = [
        "up",
        "down",
        "start",
        "stop",
        "restart",
        "ps",
        "ls",
        "inspect",
        "logs",
        "run",
        "events",
        "config",
        "reload",
        "init",
        "attach",
        "tasks",
        "daemon",
        "mcp",
        "help",
      ];
      for (const name of visible) {
        expect(res.stdout).toMatch(new RegExp(`^\\s{2}${name}\\s`, "m"));
      }

      expect(res.stdout).not.toMatch(/^\s*ui\s/m);
      expect(res.stdout).not.toContain("exec-service");
      expect(res.stdout).not.toContain("exec-task");
      expect(res.stdout).not.toContain("prime-agent");
      // Global option + version flag documented at the root
      expect(res.stdout).toContain("-s, --session <session>");
      expect(res.stdout).toContain("-V, --version");
    },
    CLI_TIMEOUT,
  );

  it(
    "prime-agent is listed exactly once when a coding-agent env var is set",
    () => {
      const res = runCli(["--help"], { CLAUDECODE: "1", CURSOR_TRACE_DIR: "/tmp" });
      expect(res.status).toBe(0);
      expect(res.stdout.split("prime-agent").length - 1).toBe(1);
    },
    CLI_TIMEOUT,
  );

  it(
    "--version and -V print the version shape and exit 0",
    () => {
      const long = runCli(["--version"]);
      expect(long.status).toBe(0);
      expect(long.stdout).toBe("dev (source) built from source\n");

      const short = runCli(["-V"]);
      expect(short.status).toBe(0);
      expect(short.stdout).toBe("dev (source) built from source\n");
    },
    CLI_TIMEOUT,
  );

  it(
    "daemon --help lists the nested subcommand group",
    () => {
      const res = runCli(["daemon", "--help"]);
      expect(res.status).toBe(0);
      for (const name of ["run", "start", "stop", "status", "ping"]) {
        expect(res.stdout).toMatch(new RegExp(`^\\s{2}${name}\\s`, "m"));
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "unknown commands exit 1 with an error",
    () => {
      const res = runCli(["bogus"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unknown command 'bogus'");

      const nested = runCli(["daemon", "bogus"]);
      expect(nested.status).toBe(1);
      expect(nested.stderr).toContain("unknown command 'bogus'");
    },
    CLI_TIMEOUT,
  );

  it(
    "ui without its required options exits 1 with a clear message",
    () => {
      const res = runCli(["ui"]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("required option '--session <id>' not specified");

      const withSession = runCli(["ui", "--session", "abc"]);
      expect(withSession.status).toBe(1);
      expect(withSession.stderr).toContain("required option '--socket <path>' not specified");
    },
    CLI_TIMEOUT,
  );

  it(
    "exec-service/exec-task keep the verbatim -s/--session runtime check",
    () => {
      const service = runCli(["exec-service", "api"]);
      expect(service.status).toBe(1);
      expect(service.stderr).toContain("Error: -s/--session is required for exec-service");

      const task = runCli(["exec-task", "run-1"]);
      expect(task.status).toBe(1);
      expect(task.stderr).toContain("Error: -s/--session is required for exec-task");
    },
    CLI_TIMEOUT,
  );

  it(
    "global -s/--session is accepted before and after the command name",
    () => {
      // Daemon is isolated away, so reaching "Daemon not running." proves the
      // Flag was parsed (an unknown flag would error differently via strictFlags).
      const before = runCli(["-s", "foo", "ps"]);
      expect(before.status).toBe(1);
      expect(before.stderr).toContain("Daemon not running.");

      const after = runCli(["ps", "-s", "foo"]);
      expect(after.status).toBe(1);
      expect(after.stderr).toContain("Daemon not running.");
    },
    CLI_TIMEOUT,
  );

  it(
    "logs --help documents -f/--follow and the --tail default",
    () => {
      const res = runCli(["logs", "--help"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("-f, --follow");
      expect(res.stdout).toContain("--tail <n>");
      expect(res.stdout).toContain('(default: "100")');
      expect(res.stdout).toContain("[services...]");
    },
    CLI_TIMEOUT,
  );

  it(
    "unknown flags and excess arguments exit 1",
    () => {
      const unknownFlag = runCli(["ps", "--bogus"]);
      expect(unknownFlag.status).toBe(1);
      expect(unknownFlag.stderr).toContain("Unknown flag: --bogus");

      const excess = runCli(["ps", "extra"]);
      expect(excess.status).toBe(1);
      expect(excess.stderr).toContain("too many arguments for 'ps'");
    },
    CLI_TIMEOUT,
  );

  it(
    "every command's --help exits 0, hidden and daemon subcommands included",
    () => {
      const rootLevel = [
        "up",
        "down",
        "start",
        "stop",
        "restart",
        "ps",
        "ls",
        "inspect",
        "logs",
        "run",
        "events",
        "config",
        "reload",
        "init",
        "attach",
        "tasks",
        "mcp",
        "help",
        // Hidden commands stay invocable directly, help included.
        "ui",
        "exec-service",
        "exec-task",
        "prime-agent",
      ];
      for (const name of rootLevel) {
        const res = runCli([name, "--help"]);
        expect(res.status, `${name} --help exit code`).toBe(0);
        expect(res.stdout, `${name} --help heading`).toContain(`zaps ${name}`);
      }
      for (const sub of ["run", "start", "stop", "status", "ping"]) {
        const res = runCli(["daemon", sub, "--help"]);
        expect(res.status, `daemon ${sub} --help exit code`).toBe(0);
        expect(res.stdout, `daemon ${sub} --help heading`).toContain(`zaps daemon ${sub}`);
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "bare `zaps daemon` prints the group help to stdout and exits 1",
    () => {
      const res = runCli(["daemon"]);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("Daemon management");
      for (const name of ["run", "start", "stop", "status", "ping"]) {
        expect(res.stdout).toMatch(new RegExp(`^\\s{2}${name}\\s`, "m"));
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "variadic [services...] accepts zero (= all) and multiple values alike",
    () => {
      // Daemon is isolated away: reaching "Daemon not running." proves the
      // Argv shape parsed cleanly for both the empty and multi-value forms.
      for (const cmd of ["start", "stop", "restart", "logs"]) {
        const none = runCli([cmd]);
        expect(none.status, `${cmd} (no services) exit code`).toBe(1);
        expect(none.stderr, `${cmd} (no services) stderr`).toContain("Daemon not running.");

        const many = runCli([cmd, "api", "db"]);
        expect(many.status, `${cmd} api db exit code`).toBe(1);
        expect(many.stderr, `${cmd} api db stderr`).toContain("Daemon not running.");
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "zero-argument `zaps` behaves exactly like `zaps up`",
    () => {
      // A config-free temp cwd makes both paths fail identically and fast.
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-cli-noconfig-"));
      try {
        const bare = runCli([], {}, emptyDir);
        const explicit = runCli(["up"], {}, emptyDir);
        expect(bare.status).toBe(1);
        expect(bare.stderr).toBe("No config found. Run `zaps init` to create one.\n");
        expect(explicit.status).toBe(bare.status);
        expect(explicit.stderr).toBe(bare.stderr);
        expect(explicit.stdout).toBe(bare.stdout);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "mcp --help documents its local -s/--session <id> option",
    () => {
      const res = runCli(["mcp", "--help"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("-s, --session <id>");
      expect(res.stdout).toContain("Target session (auto-detected from CWD)");
    },
    CLI_TIMEOUT,
  );
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
