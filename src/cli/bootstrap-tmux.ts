import { spawn } from "node:child_process";
import path from "node:path";

import { isDaemonRunning, socketPath } from "#src/daemon/lifecycle.js";
import { sessionId } from "#src/daemon/session.js";
import { getEnv } from "#src/lib/env.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import {
  MANAGED_SOCKET,
  buildAttachArgs,
  buildCreateArgs,
  buildNewWindowArgs,
  buildRespawnArgs,
  buildSetPaneOptionArgs,
  buildSetSessionOptionArgs,
  hasManagedSession,
  killStaleSession,
  managedSessionName,
  tmuxAvailable,
  waitForPaneSettled,
} from "#src/lib/managed-tmux.js";
import { defaultTmux } from "#src/lib/tmux-default.js";
import { tmuxFor } from "#src/lib/tmux.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

import type { SessionInfo } from "./helpers.js";
import { resolveCommandArgv } from "./helpers.js";
import { decideTmuxContext } from "./tmux-context.js";
import type { DaemonSessionView } from "./tmux-context.js";

/** How long the inner `zaps up -d` may take to settle before we give up (F4). */
const DETACHED_SETTLE_TIMEOUT_MS = 120_000;

/** How long to wait for a foreground-created session to appear before options. */
const SESSION_VISIBLE_TIMEOUT_MS = 5000;

/** Gap between `has-session` probes while waiting for the session to appear. */
const SESSION_POLL_MS = 25;

/** Printed to the plain terminal after the tmux client goes away (F2). */
const DETACHED_HINT = "detached — services still running. zaps to re-attach, zaps down to stop.";

interface BootstrapIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** The tmux commands the bootstrap issues — always on {@link MANAGED_SOCKET}. */
type BootstrapTmux = Pick<
  TmuxHandle,
  "capturePane" | "displayMessage" | "hasSession" | "killSession" | "listPanes" | "tmuxVersion"
>;

interface BootstrapDeps {
  io: BootstrapIo;
  tmux: BootstrapTmux;
  /** Run `tmux <args>`; `inherit` hands the current TTY to the child. */
  runTmux: (args: string[], inherit: boolean) => Promise<number>;
  /** This project's live daemon session, or undefined (daemon down / none). */
  daemonSession: (configPath: string) => Promise<DaemonSessionView | undefined>;
  /** Name of the tmux session this process runs in (only asked for inside tmux). */
  currentTmuxSession: () => Promise<string | undefined>;
  /** How to invoke zaps inside the managed pane, as argv (never a joined string). */
  zapsArgv: () => string[];
  /** Terminal size to create the session at, so panes start at the right size. */
  size: () => { height: number; width: number } | undefined;
  /** How long `up -d` may take to settle before the outer CLI gives up. */
  settleTimeoutMs: number;
  /** How long to wait for a foreground-created session before giving up on options. */
  sessionVisibleTimeoutMs: number;
}

/** Outcome for the caller: continue with the normal in-tmux flow, or exit. */
type BootstrapResult = { proceed: true } | { proceed: false; exitCode: number };

interface EnsureTmuxContextOptions {
  configPath: string;
  projectDir: string;
  detach: boolean;
  deps?: Partial<BootstrapDeps>;
}

/** Run `tmux <args>` to completion, resolving its exit code. */
async function spawnTmux(args: string[], inherit: boolean): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("tmux", args, { stdio: inherit ? "inherit" : "ignore" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Ask the daemon (if up) for this project's session — F6/F9 need it first. */
async function daemonSessionFor(configPath: string): Promise<DaemonSessionView | undefined> {
  if (!isDaemonRunning()) {
    return undefined;
  }
  const res = await ipcRequest(socketPath(), "session.list").catch(() => null);
  if (!res || res.error) {
    return undefined;
  }
  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  const sessions = res.result as SessionInfo[];
  const id = sessionId(configPath);
  const match = sessions.find((s) => s.id === id);
  return (
    match && {
      name: match.name,
      tmuxSession: match.tmuxSession,
      managed: match.managed,
      tuiPane: match.tuiPane,
    }
  );
}

function defaultDeps(): BootstrapDeps {
  return {
    io: {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    },
    tmux: tmuxFor(MANAGED_SOCKET),
    runTmux: spawnTmux,
    daemonSession: daemonSessionFor,
    // Env-based handle on purpose: this asks about the tmux we are INSIDE, which
    // Is the managed server only when the marker env says so.
    currentTmuxSession: async () => {
      try {
        return await defaultTmux.currentSession();
      } catch {
        return undefined;
      }
    },
    zapsArgv: () => {
      const { file, args } = resolveCommandArgv();
      return [file, ...args];
    },
    size: () => {
      const { columns, rows } = process.stdout;
      return columns && rows ? { width: columns, height: rows } : undefined;
    },
    settleTimeoutMs: DETACHED_SETTLE_TIMEOUT_MS,
    sessionVisibleTimeoutMs: SESSION_VISIBLE_TIMEOUT_MS,
  };
}

/**
 * Env the managed session must carry beyond the two markers: whatever locates
 * the daemon. The outer zaps decided F6/F9 against *its* daemon, so the inner
 * one has to reach the same instance — a tmux server started long ago (or by
 * another shell) would otherwise hand it a different environment.
 */
function daemonEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["ZAPS_SOCKET_PATH", "XDG_RUNTIME_DIR"]) {
    const value = getEnv(key);
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

/** First pane of `name` on the managed socket — the bootstrap (TUI) pane. */
async function bootstrapPaneId(deps: BootstrapDeps, name: string): Promise<string | undefined> {
  const panes = await deps.tmux.listPanes(name).catch(() => []);
  return panes[0]?.id;
}

/**
 * Apply what a managed session needs, best-effort:
 * - `destroy-unattached off`, so a user config that kills unattached sessions
 *   can't take the services down the moment the client detaches;
 * - pane-level `remain-on-exit on` on the bootstrap pane, which is what makes
 *   the `-d` exit code readable and (in P03) the dead pane revivable.
 */
async function applyManagedOptions(
  deps: BootstrapDeps,
  name: string,
  paneId: string | undefined,
): Promise<void> {
  await deps.runTmux(buildSetSessionOptionArgs(name, "destroy-unattached", "off"), false);
  if (paneId) {
    await deps.runTmux(buildSetPaneOptionArgs(paneId, "remain-on-exit", "on"), false);
  }
}

/** Bounded poll for the session to exist — it is created by a child we don't await. */
async function waitForSession(deps: BootstrapDeps, name: string): Promise<boolean> {
  const deadline = Date.now() + deps.sessionVisibleTimeoutMs;
  /* eslint-disable no-await-in-loop -- bounded poll on a real condition */
  while (Date.now() < deadline) {
    if (await hasManagedSession(name, deps.tmux)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

/**
 * Print the post-detach line (F2) when the session outlived the tmux client.
 * A session that is gone means teardown (`zaps down` / Ctrl-D), which prints its
 * own summary — so the `has-session` probe is what tells the two apart.
 */
async function reportDetached(deps: BootstrapDeps, name: string): Promise<void> {
  if (await hasManagedSession(name, deps.tmux)) {
    deps.io.stdout(`${DETACHED_HINT}\n`);
  }
}

/**
 * Wait for a foreground-created session, then apply its options. Best-effort by
 * design: a missing option never justifies failing the session the user is
 * already looking at.
 */
async function applyOptionsWhenVisible(deps: BootstrapDeps, name: string): Promise<void> {
  try {
    if (await waitForSession(deps, name)) {
      await applyManagedOptions(deps, name, await bootstrapPaneId(deps, name));
    }
  } catch {
    // Nothing to recover: the session lives on without the option.
  }
}

/**
 * F1: create the managed session in the foreground and hand it the terminal.
 * The child owns the TTY until the user detaches or the session ends, so the
 * session options are applied concurrently as soon as the session shows up.
 * The outer exit code mirrors the tmux client (per 50_api).
 */
async function spawnAttached(deps: BootstrapDeps, name: string): Promise<BootstrapResult> {
  const args = buildCreateArgs({
    name,
    zapsArgv: [...deps.zapsArgv(), "up"],
    env: daemonEnv(),
  });
  const attached = deps.runTmux(args, true);
  const options = applyOptionsWhenVisible(deps, name);

  const exitCode = await attached;
  await options;
  await reportDetached(deps, name);
  return { proceed: false, exitCode };
}

/**
 * F4: create the session detached, wait for the inner `zaps up -d` to settle,
 * then report. On failure the inner output is replayed and the half-created
 * session is killed so no orphan is left behind.
 *
 * The session is created running the plain shell and only *then* respawned with
 * the zaps command: `remain-on-exit` has to be in place before the command can
 * exit, otherwise a fast failure (bad config) takes the pane — and with it the
 * exit code and the error text — down with it.
 */
async function spawnDetached(deps: BootstrapDeps, name: string): Promise<BootstrapResult> {
  const args = buildCreateArgs({ name, detach: true, env: daemonEnv(), ...deps.size() });
  if ((await deps.runTmux(args, false)) !== 0) {
    deps.io.stderr(`Failed to create managed tmux session ${name}.\n`);
    return { proceed: false, exitCode: 1 };
  }

  const paneId = await bootstrapPaneId(deps, name);
  await applyManagedOptions(deps, name, paneId);
  if (!paneId) {
    deps.io.stderr(`Managed tmux session ${name} vanished before it could start.\n`);
    await killStaleSession(name, deps.tmux);
    return { proceed: false, exitCode: 1 };
  }

  const zapsArgv = [...deps.zapsArgv(), "up", "-d"];
  if ((await deps.runTmux(buildRespawnArgs(paneId, zapsArgv, { kill: true }), false)) !== 0) {
    deps.io.stderr(`Failed to start zaps in managed tmux session ${name}.\n`);
    await killStaleSession(name, deps.tmux);
    return { proceed: false, exitCode: 1 };
  }

  const settlement = await waitForPaneSettled(paneId, {
    timeoutMs: deps.settleTimeoutMs,
    tmux: deps.tmux,
  });
  if (settlement.settled && settlement.exitCode === 0) {
    deps.io.stdout(`Session ${name} started (detached, managed tmux). zaps attach to view.\n`);
    return { proceed: false, exitCode: 0 };
  }

  // Replay what the inner run printed before it died — that text is the only
  // Thing the user can act on, and the pane is about to be killed.
  const output = await deps.tmux.capturePane(paneId, 200).catch(() => "");
  if (output.trim()) {
    deps.io.stderr(`${output.trimEnd()}\n`);
  }
  if (!settlement.settled) {
    deps.io.stderr(
      settlement.reason === "timeout"
        ? `Timed out waiting for ${name} to start.\n`
        : `Managed tmux session ${name} died before reporting a result.\n`,
    );
  }
  await killStaleSession(name, deps.tmux);
  return { proceed: false, exitCode: settlement.settled ? settlement.exitCode : 1 };
}

/**
 * State of the TUI pane we want to re-enter: `"alive"` (still running — nothing
 * to do), `"dead"` (held by `remain-on-exit`, revive it), `"gone"` (the pane no
 * longer exists at all).
 */
async function tuiPaneState(
  deps: BootstrapDeps,
  session: string,
  paneId: string | null,
): Promise<"alive" | "dead" | "gone"> {
  if (!paneId) {
    return "gone";
  }
  // Listing the SESSION's panes and looking ours up, rather than probing the
  // Pane directly: tmux answers `display-message -t %99` for a pane that no
  // Longer exists with an empty string and exit 0, which would read as "alive".
  const livePanes = await deps.tmux.listPanes(session).catch(() => []);
  const pane = livePanes.find((p) => p.id === paneId);
  if (!pane) {
    return "gone";
  }
  return pane.dead ? "dead" : "alive";
}

/**
 * F3: put a live `zaps attach` back into the preserved TUI pane, then hand the
 * terminal to tmux. The pane is respawned WITHOUT `-k`: it is dead-but-held, and
 * demanding a kill would mask the case where the TUI is somehow still running.
 * If the pane is gone entirely (user killed it by hand) a new window takes its
 * place rather than failing the command — 70_risks fallback.
 */
async function reviveTuiPane(
  deps: BootstrapDeps,
  name: string,
  paneId: string | null,
): Promise<void> {
  const zapsArgv = [...deps.zapsArgv(), "attach"];
  const state = await tuiPaneState(deps, name, paneId);
  if (state === "alive") {
    return;
  }
  if (state === "dead" && paneId) {
    if ((await deps.runTmux(buildRespawnArgs(paneId, zapsArgv), false)) === 0) {
      return;
    }
    deps.io.stderr(`Could not revive the zaps pane; opening a new window instead.\n`);
  } else {
    deps.io.stderr(`zaps pane is gone; opening a new window instead.\n`);
  }
  await deps.runTmux(buildNewWindowArgs(name, zapsArgv), false);
}

/**
 * Re-enter an existing managed session: revive its TUI pane, attach in the
 * foreground, and report on the way out. Exported for `zaps attach`, which
 * resolves its target itself (`-s`, or the cwd's project).
 */
async function reattachManaged(options: {
  name: string;
  tuiPane: string | null;
  deps?: Partial<BootstrapDeps>;
}): Promise<BootstrapResult> {
  const deps: BootstrapDeps = { ...defaultDeps(), ...options.deps };
  await reviveTuiPane(deps, options.name, options.tuiPane);
  const exitCode = await deps.runTmux(buildAttachArgs(options.name), true);
  await reportDetached(deps, options.name);
  return { proceed: false, exitCode };
}

/**
 * Decide and act on this process's tmux context before `up` / the smart default
 * runs. `{ proceed: true }` means "carry on with today's in-tmux flow"; anything
 * else means the terminal was handed to tmux (or a message was printed) and the
 * caller must exit with the returned code.
 */
async function ensureTmuxContext(options: EnsureTmuxContextOptions): Promise<BootstrapResult> {
  const deps: BootstrapDeps = { ...defaultDeps(), ...options.deps };
  const tmuxEnv = getEnv("TMUX");
  const daemonSession = await deps.daemonSession(options.configPath);
  // Only needed to tell "inside the project's own managed session" apart from
  // "inside some other tmux" — so only asked for when both can be true.
  const currentTmuxSession =
    tmuxEnv && daemonSession?.managed ? await deps.currentTmuxSession() : undefined;

  // Named from the project DIRECTORY (not the config's display name) so the name
  // Is stable across runs without loading the config here — that stability is
  // What makes stale detection (F9) work at all.
  const managedName = managedSessionName(
    path.basename(options.projectDir),
    sessionId(options.configPath),
  );

  // Both probes cost a subprocess, so only run them where the decision uses
  // Them: outside tmux, and staleness only when the daemon knows no session.
  const availability = tmuxEnv
    ? ({ ok: true, version: "" } as const)
    : await tmuxAvailable(deps.tmux);
  const managedSessionExists =
    !tmuxEnv && availability.ok && !daemonSession
      ? await hasManagedSession(managedName, deps.tmux)
      : false;

  const decision = decideTmuxContext({
    tmuxEnv,
    autoTmuxEnv: getEnv("ZAPS_AUTO_TMUX"),
    detach: options.detach,
    tmuxAvailability: availability,
    daemonSession,
    currentTmuxSession,
    managedName,
    managedSessionExists,
  });

  switch (decision.kind) {
    case "proceed-inside": {
      return { proceed: true };
    }
    case "error-legacy":
    case "error-no-tmux":
    case "refuse-managed":
    case "refuse-personal": {
      deps.io.stderr(`${decision.message}\n`);
      return { proceed: false, exitCode: 1 };
    }
    case "already-running": {
      deps.io.stdout(`${decision.message}\n`);
      return { proceed: false, exitCode: 0 };
    }
    case "kill-stale-then-spawn": {
      await killStaleSession(decision.name, deps.tmux);
      return decision.detach
        ? spawnDetached(deps, decision.name)
        : spawnAttached(deps, decision.name);
    }
    case "spawn": {
      return spawnAttached(deps, decision.name);
    }
    case "spawn-detached": {
      return spawnDetached(deps, decision.name);
    }
    case "reattach": {
      return reattachManaged({ name: decision.name, tuiPane: decision.tuiPane, deps });
    }
    default: {
      // Unreachable: the union above is exhaustive.
      return { proceed: true };
    }
  }
}

export { DETACHED_HINT, ensureTmuxContext, reattachManaged };
export type { BootstrapDeps, BootstrapIo, BootstrapResult, BootstrapTmux };
