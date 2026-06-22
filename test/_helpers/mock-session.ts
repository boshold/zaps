import { vi } from "vitest";

import { LogBuffer } from "../../src/daemon/log-buffer.js";
import type { SessionStore } from "../../src/daemon/server.js";
import type { Session } from "../../src/daemon/session.js";
import { TaskOutputStore } from "../../src/daemon/task-output-store.js";
import type { PaneRunInfo } from "../../src/lib/task/run-in-pane.js";

export interface MockSession {
  id: string;
  name: string;
  configPath: string;
  projectDir: string;
  config: {
    project: {
      name: string;
      services: Record<string, unknown>;
      tasks?: Record<string, unknown>;
    };
    projectDir: string;
    configPath: string;
    unavailableServices: Map<string, { name: string; reason: string }>;
  };
  paneMap: Record<string, string>;
  tmuxSession: string;
  originPane: string;
  execInfo: Map<string, { command: string; cwd: string; env: Record<string, string> }>;
  panesByRun: Map<string, string>;
  paneRunInfo: Map<string, PaneRunInfo>;
  taskOutput: TaskOutputStore;
  manager: {
    getAllStatuses: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    startService: ReturnType<typeof vi.fn>;
    stopService: ReturnType<typeof vi.fn>;
    restartService: ReturnType<typeof vi.fn>;
    startAll: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
    handleExecExited: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  logBuffers: Map<string, LogBuffer>;
  logMonitor: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
  };
  subscribers: Set<unknown>;
  createdAt: number;
  taskHistory: unknown[];
  deps: { zapsCommand: string; sessionId: string };
  attachSnapshot: ReturnType<typeof vi.fn>;
  startAll: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  pushTaskRecord: ReturnType<typeof vi.fn>;
  addSubscriber: ReturnType<typeof vi.fn>;
  removeSubscriber: ReturnType<typeof vi.fn>;
  focusPane: string;
}

export function createMockSession(overrides: Partial<MockSession> = {}): MockSession {
  const logBuffers = overrides.logBuffers ?? new Map([["api", new LogBuffer(100)]]);
  const subscribers = overrides.subscribers ?? new Set<unknown>();
  return {
    id: "abc123",
    name: "test-project",
    configPath: "/fake/.zaps.mts",
    projectDir: "/fake",
    config: {
      project: {
        name: "test-project",
        services: { api: { start: "npm dev" } },
        tasks: {},
      },
      projectDir: "/fake",
      configPath: "/fake/.zaps.mts",
      unavailableServices: new Map(),
    },
    paneMap: { "@tui": "%0", api: "%1" },
    tmuxSession: "test-tmux",
    originPane: "%0",
    execInfo: overrides.execInfo ?? new Map(),
    panesByRun: overrides.panesByRun ?? new Map(),
    paneRunInfo: overrides.paneRunInfo ?? new Map(),
    taskOutput: overrides.taskOutput ?? new TaskOutputStore(),
    manager: {
      getAllStatuses: vi.fn(() => [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }]),
      getStatus: vi.fn((name: string) => {
        if (name === "api") {
          return { name: "api", state: "ready", ports: [3000], retryCount: 0 };
        }
        throw new Error(`Unknown service: ${name}`);
      }),
      startService: vi.fn().mockResolvedValue({ noop: false }),
      stopService: vi.fn().mockResolvedValue({ noop: false }),
      restartService: vi.fn().mockResolvedValue(undefined),
      startAll: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
      handleExecExited: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    },
    logBuffers,
    logMonitor: {
      start: vi.fn(),
      stop: vi.fn(),
      stopAll: vi.fn(),
    },
    subscribers,
    addSubscriber: vi.fn((socket: unknown) => subscribers.add(socket)),
    removeSubscriber: vi.fn((socket: unknown) => subscribers.delete(socket)),
    focusPane: "%0",
    createdAt: Date.now(),
    taskHistory: [],
    deps: overrides.deps ?? { zapsCommand: "zaps", sessionId: "abc123" },
    attachSnapshot: vi.fn(() => ({
      id: "abc123",
      name: "test-project",
      paneMap: { "@tui": "%0", api: "%1" },
      tmuxSession: "test-tmux",
      originPane: "%0",
      statuses: [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }],
      logSnapshots: { api: [] },
      configPath: "/fake/.zaps.mts",
      projectDir: "/fake",
      tasks: [],
      servicesMeta: [],
      taskHistory: [],
      unavailableServices: [],
    })),
    startAll: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    pushTaskRecord: vi.fn(),
    ...overrides,
  };
}

export function createMockStore(sessions: MockSession[] = []): SessionStore {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  return {
    list: () => [...sessionMap.values()] as unknown as Session[],
    get: (id: string) => sessionMap.get(id) as unknown as Session | undefined,
    getByProjectDir: (dir: string) =>
      [...sessionMap.values()].find((s) => s.projectDir === dir) as unknown as Session | undefined,
    create: vi.fn().mockImplementation(async () => sessions[0]),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}
