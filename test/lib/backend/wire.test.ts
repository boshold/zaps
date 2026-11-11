import { describe, expect, it } from "vitest";

import { SessionClosingError } from "#src/lib/backend/admission-error.js";
import {
  parseDaemonStatus,
  parseServiceStatus,
  parseSessionListEntry,
  parseSessionSnapshot,
  unavailableActions,
  unavailableCapabilities,
} from "#src/lib/backend/wire.js";
import { ipcErr } from "#src/lib/ipc/protocol.js";

function legacySnapshot() {
  return {
    id: "s",
    name: "project",
    tmuxSession: "main",
    managed: true,
    originPane: "%0",
    paneMap: { api: "%1" },
    statuses: [
      {
        name: "api",
        state: "ready",
        ports: [3000],
        retryCount: 0,
        paneId: "%1",
        isDetached: false,
      },
    ],
    logSnapshots: { api: ["ready"] },
    configPath: "/project/.zaps.mts",
    projectDir: "/project",
    tasks: [],
    servicesMeta: [],
    taskHistory: [],
    unavailableServices: [],
    configStale: false,
  };
}

describe("backend wire decoding", () => {
  it("normalizes actual legacy snapshots without inventing fields or pane support", () => {
    const snapshot = parseSessionSnapshot(legacySnapshot());
    expect(snapshot.backend).toBe("tmux");
    expect(snapshot.capabilities).toEqual(unavailableCapabilities);
    expect(snapshot.statuses[0]).toMatchObject({ isDetached: false, actions: unavailableActions });
    expect(snapshot).not.toHaveProperty("createdAt");
    expect(() => parseSessionSnapshot({ id: "s", statuses: [] })).toThrow();
  });

  it.each([
    { backend: undefined },
    { backend: "future" },
    { capabilities: unavailableCapabilities },
    { backend: "tmux" },
  ])("rejects partial or explicit malformed metadata %j", (fields) => {
    expect(() => parseSessionSnapshot({ ...legacySnapshot(), ...fields })).toThrow();
  });

  it("requires all status fields and complete new actions", () => {
    expect(() => parseServiceStatus({ state: "ready" })).toThrow();
    expect(() =>
      parseServiceStatus({ ...legacySnapshot().statuses[0], actions: { focus: true } }),
    ).toThrow();
    expect(() =>
      parseSessionSnapshot({
        ...legacySnapshot(),
        backend: "tmux",
        capabilities: unavailableCapabilities,
      }),
    ).toThrow();
  });

  it("downgrades RPC actions even on new snapshots without trusted advertisement", () => {
    const snapshot = {
      ...legacySnapshot(),
      backend: "tmux",
      capabilities: { ...unavailableCapabilities, panes: true },
      statuses: [
        { ...legacySnapshot().statuses[0], actions: { focus: true, zoom: true, editOutput: true } },
      ],
    };
    expect(parseSessionSnapshot(snapshot, false)).toMatchObject({
      capabilities: unavailableCapabilities,
      statuses: [{ actions: unavailableActions }],
    });
    expect(parseSessionSnapshot(snapshot, true).statuses[0].actions.focus).toBe(true);
  });

  it("preserves minimal legacy list identity without fake dates or config paths", () => {
    const entry = parseSessionListEntry({ id: "s", name: "project", projectDir: "/project" });
    expect(entry).toMatchObject({ backend: "tmux", capabilities: unavailableCapabilities });
    expect(entry).not.toHaveProperty("createdAt");
    expect(entry).not.toHaveProperty("configPath");
    expect(() => parseSessionListEntry({ ...entry, backend: "shell" })).toThrow();
  });

  it("treats missing advertisement as tmux-only and rejects explicit malformed support", () => {
    expect(parseDaemonStatus({ pid: 42, sessions: [] })).toMatchObject({
      advertised: false,
      supportedBackends: ["tmux"],
    });
    expect(() =>
      parseDaemonStatus({ pid: 42, sessions: [], supportedBackends: ["future"] }),
    ).toThrow();
  });

  it("retains typed errors without guessing human strings or adding result", () => {
    expect(ipcErr("r", new SessionClosingError())).toEqual({
      id: "r",
      error: "session_closing",
      errorCode: "session_closing",
    });
    expect(ipcErr("r", new Error("session_closing"))).toEqual({
      id: "r",
      error: "session_closing",
    });
    expect(ipcErr("r", { code: "bogus" })).not.toHaveProperty("errorCode");
  });
});
