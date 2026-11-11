import type { SessionSnapshot } from "../../src/daemon/session.js";
import { unavailableCapabilities } from "../../src/lib/backend/wire.js";

type TmuxSnapshot = Extract<SessionSnapshot, { backend: "tmux" }>;

export function makeSessionSnapshot(overrides: Partial<TmuxSnapshot> = {}): TmuxSnapshot {
  return {
    id: "sess1",
    name: "test",
    backend: "tmux",
    capabilities: { ...unavailableCapabilities },
    tmuxSession: "main",
    managed: false,
    originPane: "%0",
    paneMap: {},
    statuses: [],
    logSnapshots: {},
    configPath: "/project/.zaps.mts",
    projectDir: "/project",
    tasks: [],
    servicesMeta: [],
    taskHistory: [],
    unavailableServices: [],
    configStale: false,
    ...overrides,
  };
}
