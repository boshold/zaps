import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { LogBuffer } from "../../src/daemon/log-buffer.js";
import type { SessionStore } from "../../src/daemon/server.js";
import { compatibilityProjection } from "../../src/daemon/session.js";
import type { Session } from "../../src/daemon/session.js";
import { TaskOutputStore } from "../../src/daemon/task-output-store.js";
import type { SentraDeps } from "../../src/lib/sentra/config.js";
import { ErrorCounter } from "../../src/lib/sentra/counter.js";
import { SentraHost } from "../../src/lib/sentra/host.js";
import type { PaneRunInfo } from "../../src/lib/task/run-in-pane.js";
import { tmuxFor } from "../../src/lib/tmux.js";
import type { TmuxHandle } from "../../src/lib/tmux.js";

const MOCK_PORT_STATE_PATH = path.join(os.tmpdir(), `zaps-mock-sentra-${process.pid}.json`);

export interface MockSession {
  backend: {
    id: "tmux" | "shell";
    capabilities: import("../../src/lib/backend/types.js").BackendCapabilities;
  };
  id: string;
  name: string;
  configPath: string;
  projectDir: string;
  config: {
    project: {
      name: string;
      services: Record<string, unknown>;
      tasks?: Record<string, unknown>;
      sentra?: { enabled?: boolean; env: Record<string, string> };
    };
    projectDir: string;
    configPath: string;
    unavailableServices: Map<string, { name: string; reason: string }>;
  };
  paneMap: Record<string, string>;
  tmux: TmuxHandle;
  tmuxSocket: string | null;
  managedTmux: boolean;
  tmuxSession: string;
  originPane: string;
  execInfo: Map<string, { command: string; cwd: string; env: Record<string, string> }>;
  panesByRun: Map<string, string>;
  paneRunInfo: Map<string, PaneRunInfo>;
  taskOutput: TaskOutputStore;
  manager: {
    getAllStatuses: ReturnType<typeof vi.fn<() => Parameters<Session["projectStatus"]>[0][]>>;
    getStatus: ReturnType<typeof vi.fn>;
    startService: ReturnType<typeof vi.fn>;
    stopService: ReturnType<typeof vi.fn>;
    restartService: ReturnType<typeof vi.fn>;
    startAll: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
    handleExecExited: ReturnType<
      typeof vi.fn<
        (service: string, code: number, signal: string | null, spawnError?: string) => void
      >
    >;
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
  ephemeral: boolean;
  startupPending: boolean;
  taskHistory: unknown[];
  deps: { zapsCommand: string; sessionId: string; sentra?: SentraDeps };
  attachSnapshot: ReturnType<typeof vi.fn>;
  startAll: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  pushTaskRecord: ReturnType<typeof vi.fn>;
  prepareTask: ReturnType<typeof vi.fn<Session["prepareTask"]>>;
  acquireTask: ReturnType<typeof vi.fn<Session["acquireTask"]>>;
  beginInitialStartup: ReturnType<typeof vi.fn<Session["beginInitialStartup"]>>;
  waitForInitialStartup: ReturnType<typeof vi.fn<Session["waitForInitialStartup"]>>;
  release: ReturnType<typeof vi.fn<() => void>>;
  addSubscriber: ReturnType<typeof vi.fn>;
  removeSubscriber: ReturnType<typeof vi.fn>;
  focusPane: string;
  compatibilityProjection: Session["compatibilityProjection"];
  projectStatuses: Session["projectStatuses"];
  projectStatus: Session["projectStatus"];
}

export function createMockSession(overrides: Partial<MockSession> = {}): MockSession {
  const logBuffers = overrides.logBuffers ?? new Map([["api", new LogBuffer(100)]]);
  const subscribers = overrides.subscribers ?? new Set<unknown>();
  return {
    backend: {
      id: "tmux",
      capabilities: {
        panes: true,
        zoom: true,
        popups: true,
        taskPanes: true,
        rawInput: true,
        layout: true,
      },
    },
    id: "abc123",
    name: "test-project",
    ephemeral: false,
    startupPending: false,
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
    tmux: tmuxFor(null),
    tmuxSocket: null,
    managedTmux: false,
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
    compatibilityProjection() {
      return compatibilityProjection({
        kind: "tmux",
        tmuxSession: this.tmuxSession,
        tmuxWindow: "@1",
        originPane: this.originPane,
        tmuxSocket: this.tmuxSocket,
        managedTmux: this.managedTmux,
        paneMap: this.paneMap,
        focusPane: this.focusPane,
      });
    },
    projectStatus(status) {
      return { ...status, actions: { focus: true, zoom: true, editOutput: true } };
    },
    projectStatuses() {
      return this.manager
        .getAllStatuses()
        .map((status: Parameters<Session["projectStatus"]>[0]) => this.projectStatus(status));
    },
    focusPane: "%0",
    createdAt: Date.now(),
    taskHistory: [],
    deps: overrides.deps ?? { zapsCommand: "zaps", sessionId: "abc123" },
    attachSnapshot: vi.fn(() => ({
      backend: "tmux",
      capabilities: {
        panes: true,
        zoom: true,
        popups: true,
        taskPanes: true,
        rawInput: true,
        layout: true,
      },
      managed: false,
      configStale: false,
      id: "abc123",
      name: "test-project",
      paneMap: { "@tui": "%0", api: "%1" },
      tmuxSession: "test-tmux",
      originPane: "%0",
      statuses: [
        {
          name: "api",
          state: "ready",
          ports: [3000],
          retryCount: 0,
          actions: { focus: true, zoom: true, editOutput: true },
        },
      ],
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
    prepareTask: vi.fn<Session["prepareTask"]>().mockResolvedValue({ startedServices: [] }),
    beginInitialStartup: vi.fn<Session["beginInitialStartup"]>(),
    waitForInitialStartup: vi.fn<Session["waitForInitialStartup"]>().mockResolvedValue(undefined),
    ...(() => {
      const release = vi.fn<() => void>();
      return { release, acquireTask: vi.fn<Session["acquireTask"]>(() => release) };
    })(),
    broadcast: vi.fn(),
    pushTaskRecord: vi.fn(),
    ...overrides,
  };
}

export function createMockStore(sessions: MockSession[] = []): SessionStore {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const host = new SentraHost({ dbPath: ":memory:", portStatePath: MOCK_PORT_STATE_PATH });
  return {
    list: () => [...sessionMap.values()] as unknown as Session[],
    get: (id: string) => sessionMap.get(id) as unknown as Session | undefined,
    getByProjectDir: (dir: string) =>
      [...sessionMap.values()].find((s) => s.projectDir === dir) as unknown as Session | undefined,
    create: vi.fn().mockImplementation(async () => sessions[0]),
    destroy: vi.fn().mockResolvedValue(undefined),
    sentra: host,
    sentraCounter: new ErrorCounter(host),
  };
}
