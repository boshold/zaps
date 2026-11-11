import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { daemonDir, isDaemonRunning, socketPath } from "#src/daemon/lifecycle.js";
import { sessionId } from "#src/daemon/session.js";
import { getEnv } from "#src/lib/env.js";
import {
  MANAGED_SOCKET,
  buildAttachArgs,
  buildCreateArgs,
  buildNewWindowArgs,
  buildRespawnArgs,
  buildSetPaneOptionArgs,
  buildSetSessionOptionArgs,
  hasManagedSession,
  managedSessionName,
  tmuxAvailable,
} from "#src/lib/managed-tmux.js";
import {
  ENVIRONMENT_SNAPSHOT_VARIABLE,
  captureEnvironment,
  consumeEnvironmentSnapshot,
  writeEnvironmentSnapshot,
} from "#src/lib/request-context.js";
import { defaultTmux } from "#src/lib/tmux-default.js";
import { tmuxFor } from "#src/lib/tmux.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

import { resolveCommandArgv } from "./helpers.js";
import { findStartupSession, listStartupSessions } from "./startup-session.js";
import { decideTmuxContext } from "./tmux-context.js";
import type { DaemonSessionView } from "./tmux-context.js";

const MANAGED_BOOTSTRAP_FLAG = "--managed-bootstrap";

const execFileAsync = promisify(execFile);
const resultFile = "result.json";
const pendingOption = "@zaps-bootstrap-pending";
const bootstrapOutcomeSchema = z.strictObject({
  exitCode: z.number().int().min(0).max(255),
  message: z.string().optional(),
  rollback: z.literal(true).optional(),
});
type BootstrapOutcome = z.infer<typeof bootstrapOutcomeSchema>;

interface ManagedStartup {
  canRollback: boolean;
  onUiReady?: () => void;
}

function managedBootstrapReporter(
  startup: ManagedStartup,
): ((outcome: Omit<BootstrapOutcome, "rollback">) => void) | undefined {
  const snapshot = process.env[ENVIRONMENT_SNAPSHOT_VARIABLE];
  if (!snapshot || !process.env.TMUX || !process.env.TMUX_PANE) {
    return undefined;
  }
  const directory = path.dirname(snapshot);
  if (!path.basename(directory).startsWith("bootstrap-")) {
    return undefined;
  }
  let reported = false;
  return (outcome) => {
    if (reported) {
      return;
    }
    reported = true;
    try {
      const result =
        outcome.exitCode !== 0 && startup.canRollback ? { ...outcome, rollback: true } : outcome;
      fs.writeFileSync(path.join(directory, resultFile), JSON.stringify(result), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  };
}

function consumeManagedEnvironmentSnapshot(): void {
  const {
    ZAPS_ENVIRONMENT_SNAPSHOT: snapshot,
    ZAPS_TMUX_SOCKET: socket,
    TMUX_PANE: pane,
  } = process.env;
  if (
    snapshot &&
    process.env.TMUX &&
    process.env.ZAPS_MANAGED_TMUX === "1" &&
    socket === MANAGED_SOCKET &&
    pane
  ) {
    try {
      execFileSync(
        "tmux",
        ["-L", socket, "set-environment", "-u", "-t", pane, ENVIRONMENT_SNAPSHOT_VARIABLE],
        { stdio: "ignore" },
      );
    } catch {
      /* Process-local snapshot consumption still proceeds. */
    }
    consumeEnvironmentSnapshot();
  }
}

/** How long the inner `zaps up -d` may take to settle before we give up (F4). */
const DETACHED_SETTLE_TIMEOUT_MS = 120_000;

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

interface ForegroundTmuxClient {
  result: Promise<number>;
  close(): void;
}

interface BootstrapDeps {
  io: BootstrapIo;
  tmux: BootstrapTmux;
  /** Run `tmux <args>`; `inherit` hands the current TTY to the child. */
  runTmux: (args: string[], inherit: boolean) => Promise<number>;
  createTmux: (args: string[]) => Promise<string>;
  startTmuxClient: (args: string[]) => ForegroundTmuxClient;
  /** This project's live daemon session, or undefined (daemon down / none). */
  daemonSession: (
    configPath: string,
    projectDir?: string,
  ) => Promise<DaemonSessionView | undefined>;
  /** Name of the tmux session this process runs in (only asked for inside tmux). */
  currentTmuxSession: () => Promise<string | undefined>;
  /** How to invoke zaps inside the managed pane, as argv (never a joined string). */
  zapsArgv: () => string[];
  /** Terminal size to create the session at, so panes start at the right size. */
  size: () => { height: number; width: number } | undefined;
  /** How long `up -d` may take to settle before the outer CLI gives up. */
  settleTimeoutMs: number;
}

/** Outcome for the caller: continue with the normal in-tmux flow, or exit. */
type BootstrapResult = { proceed: true } | { proceed: false; exitCode: number };

interface EnsureTmuxContextOptions {
  configPath: string;
  projectDir: string;
  detach: boolean;
  knownSession?: { current: DaemonSessionView | undefined };
  deps?: Partial<BootstrapDeps>;
}

function startTmuxProcess(args: string[], inherit: boolean): ForegroundTmuxClient {
  const child = spawn("tmux", args, { stdio: inherit ? "inherit" : "ignore" });
  const result = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  return {
    result,
    close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  };
}

/** Ask the daemon (if up) for this project's session — F6/F9 need it first. */
async function daemonSessionFor(
  configPath: string,
  projectDir = process.cwd(),
): Promise<DaemonSessionView | undefined> {
  if (!isDaemonRunning()) {
    return undefined;
  }
  const sessions = await listStartupSessions(socketPath());
  const match = findStartupSession(sessions, configPath, projectDir);
  if (match?.backend !== "tmux") {
    return undefined;
  }
  // Defaults, not assumptions: an older daemon omits the newer fields, and
  // "unknown" must read as "not managed" so nothing here touches its tmux.
  return {
    name: match.name,
    tmuxSession: match.tmuxSession ?? "",
    managed: match.managed === true,
    tuiPane: match.tuiPane ?? null,
  };
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
    runTmux: async (args, inherit) => startTmuxProcess(args, inherit).result,
    createTmux: async (args) => {
      const { stdout } = await execFileAsync("tmux", args);
      return stdout;
    },
    startTmuxClient: (args) => startTmuxProcess(args, true),
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
  };
}

/**
 * Pass the current environment through a private one-time file. Forwarding all
 * values as tmux `-e` arguments exceeds tmux's command-size limit in large shells.
 */
function managedEnvironment(directory: string): Record<string, string> {
  const env = captureEnvironment();
  Reflect.deleteProperty(env, "TMUX");
  Reflect.deleteProperty(env, "TMUX_PANE");
  Reflect.deleteProperty(env, "ZAPS_TMUX_SOCKET");
  Reflect.deleteProperty(env, "ZAPS_MANAGED_TMUX");
  Reflect.deleteProperty(env, ENVIRONMENT_SNAPSHOT_VARIABLE);
  const snapshotPath = writeEnvironmentSnapshot(directory, env);
  const routingEnv = Object.fromEntries(
    ["XDG_RUNTIME_DIR", "ZAPS_SOCKET_PATH"]
      .map((key) => [key, env[key]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  return { ...routingEnv, [ENVIRONMENT_SNAPSHOT_VARIABLE]: snapshotPath };
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

const provisionedSessionSchema = z.tuple([
  z.string().regex(/^\$\d+$/u),
  z.string().regex(/^%\d+$/u),
  z.string().regex(/^\d+$/u),
]);

interface ManagedLaunch {
  name: string;
  configPath: string;
  projectDir: string;
  detach: boolean;
}

interface ProvisionedSession {
  session: string;
  pane: string;
  serverPid: string;
}

async function provisionSession(
  deps: BootstrapDeps,
  name: string,
  env: Record<string, string>,
): Promise<ProvisionedSession> {
  const args = buildCreateArgs({
    name,
    detach: true,
    env,
    zapsArgv: ["/bin/sh", "-c", "while IFS= read -r line; do :; done"],
    ...deps.size(),
  });
  args.splice(3, 0, "-P", "-F", "#{session_id}|#{pane_id}|#{pid}");
  const stdout = await deps.createTmux([
    ...args,
    ";",
    ...buildSetSessionOptionArgs(name, "destroy-unattached", "off").slice(2),
    ";",
    ...buildSetSessionOptionArgs(name, pendingOption, "on").slice(2),
  ]);
  const [session, pane, serverPid] = provisionedSessionSchema.parse(stdout.trim().split("|"));
  return { session, pane, serverPid };
}

function readOutcome(directory: string): BootstrapOutcome | undefined {
  try {
    const result = bootstrapOutcomeSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(directory, resultFile), "utf8")),
    );
    return result.success ? result.data : undefined;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function waitForManagedOutcome(
  deps: BootstrapDeps,
  launch: ManagedLaunch,
  pane: string,
  directory: string,
  clientState: { exitCode?: number },
): Promise<BootstrapOutcome> {
  const deadline = Date.now() + deps.settleTimeoutMs;
  /* eslint-disable no-await-in-loop -- bounded polling of the result and bootstrap pane */
  while (Date.now() < deadline) {
    const outcome = readOutcome(directory);
    if (outcome && (!launch.detach || outcome.exitCode !== 0)) {
      return outcome;
    }
    if (clientState.exitCode) {
      return { exitCode: clientState.exitCode, message: `Could not attach to ${launch.name}.` };
    }
    const state = await deps.tmux
      .displayMessage(pane, "#{pane_dead}|#{pane_dead_status}")
      .catch(() => "");
    const [dead, status] = state.trim().split("|");
    if (dead === "1" || !dead) {
      const exitCode = Number(status);
      return (
        readOutcome(directory) ?? {
          exitCode: Number.isInteger(exitCode) && exitCode > 0 && exitCode <= 255 ? exitCode : 1,
        }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
  }
  /* eslint-enable no-await-in-loop */
  return { exitCode: 1, message: `Timed out waiting for ${launch.name} to start.` };
}

async function ownedHostCommand(
  deps: BootstrapDeps,
  host: Pick<ProvisionedSession, "session" | "serverPid">,
  command: string,
  requireUnmarked = false,
): Promise<number> {
  const serverMatch = `#{==:#{pid},${host.serverPid}}`;
  const match = requireUnmarked ? `#{&&:${serverMatch},#{==:#{${pendingOption}},}}` : serverMatch;
  return deps.runTmux(
    ["-L", MANAGED_SOCKET, "if-shell", "-F", "-t", host.session, match, command],
    false,
  );
}

async function daemonOwnsHost(deps: BootstrapDeps, launch: ManagedLaunch): Promise<boolean> {
  const owner = await deps.daemonSession(launch.configPath, launch.projectDir);
  return owner?.managed === true && owner.tmuxSession === launch.name;
}

async function releaseUnregistered(
  deps: BootstrapDeps,
  launch: ManagedLaunch,
  host: ProvisionedSession,
): Promise<void> {
  try {
    if (!(await daemonOwnsHost(deps, launch))) {
      await ownedHostCommand(deps, host, `kill-session -t '${host.session}'`);
    }
  } catch {
    // An unreadable daemon view cannot prove the host is unregistered.
  }
}

async function reapUnmarkedHost(deps: BootstrapDeps, name: string): Promise<boolean> {
  const state = await deps.tmux
    .displayMessage(`=${name}:`, `#{session_id}|#{pane_id}|#{pid}|#{${pendingOption}}`)
    .catch(() => "");
  const fields = state.trim().split("|");
  const host = provisionedSessionSchema.safeParse(fields.slice(0, 3));
  if (!host.success || fields.length !== 4 || fields[3] !== "") {
    return false;
  }
  const [session, , serverPid] = host.data;
  const code = await ownedHostCommand(
    deps,
    { session, serverPid },
    `kill-session -t '${session}'`,
    true,
  );
  return code === 0;
}

async function reportManagedFailure(
  deps: BootstrapDeps,
  launch: ManagedLaunch,
  host: ProvisionedSession,
  outcome: BootstrapOutcome,
  client?: ForegroundTmuxClient,
): Promise<void> {
  const output = outcome.message ?? (await deps.tmux.capturePane(host.pane, 200).catch(() => ""));
  if (outcome.rollback) {
    await releaseUnregistered(deps, launch, host);
  }
  if (client) {
    client.close();
    await client.result;
  }
  const message = output.trim()
    ? output.trimEnd()
    : `Managed tmux session ${launch.name} died before reporting a result.`;
  deps.io.stderr(`${message}\n`);
}

async function observeClient(
  client: ForegroundTmuxClient,
  state: { exitCode?: number },
): Promise<void> {
  state.exitCode = await client.result;
}

async function launchManaged(deps: BootstrapDeps, launch: ManagedLaunch): Promise<BootstrapResult> {
  const { name, detach } = launch;
  const directory = fs.mkdtempSync(path.join(daemonDir(), "bootstrap-"));
  let client: ForegroundTmuxClient | undefined = undefined;
  try {
    const host = await provisionSession(deps, name, managedEnvironment(directory)).catch(
      () => undefined,
    );
    if (!host) {
      deps.io.stderr(`Failed to create managed tmux session ${name}.\n`);
      return { proceed: false, exitCode: 1 };
    }

    await deps.runTmux(buildSetPaneOptionArgs(host.pane, "remain-on-exit", "on"), false);
    const inner = [...deps.zapsArgv(), MANAGED_BOOTSTRAP_FLAG, "up", "-B", "tmux"];
    if (detach) {
      inner.push("-d");
    }
    const respawn = buildRespawnArgs(host.pane, inner, { kill: true });
    const clientState: { exitCode?: number } = {};
    if (!detach) {
      // Tmux attaches the client before executing the next command in its queue.
      client = deps.startTmuxClient([
        "-L",
        MANAGED_SOCKET,
        "attach-session",
        "-t",
        host.session,
        ";",
        ...respawn.slice(2),
      ]);
      void observeClient(client, clientState);
    } else if ((await deps.runTmux(respawn, false)) !== 0) {
      await reportManagedFailure(deps, launch, host, {
        exitCode: 1,
        message: `Failed to start zaps in managed tmux session ${name}.`,
      });
      return { proceed: false, exitCode: 1 };
    }

    const outcome = await waitForManagedOutcome(deps, launch, host.pane, directory, clientState);
    if (outcome.exitCode !== 0) {
      await reportManagedFailure(deps, launch, host, outcome, client);
      client = undefined;
      return { proceed: false, exitCode: outcome.exitCode };
    }
    if (await daemonOwnsHost(deps, launch).catch(() => false)) {
      await ownedHostCommand(deps, host, `set-option -u -t '${host.session}:' ${pendingOption}`);
    }
    if (client) {
      fs.rmSync(directory, { recursive: true, force: true });
      const exitCode = await client.result;
      await reportDetached(deps, name);
      return { proceed: false, exitCode };
    }
    deps.io.stdout(`Session ${name} started (detached, managed tmux). zaps attach to view.\n`);
    return { proceed: false, exitCode: 0 };
  } finally {
    if (client) {
      client.close();
      await client.result;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  const daemonSession = options.knownSession
    ? options.knownSession.current
    : await deps.daemonSession(options.configPath, options.projectDir);
  // Only needed to tell "inside the project's own managed session" apart from
  // "inside some other tmux" — so only asked for when both can be true.
  const currentTmuxSession =
    tmuxEnv && daemonSession?.managed ? await deps.currentTmuxSession() : undefined;

  // Named from the project DIRECTORY (not the config's display name) so the name
  // Is stable across runs without loading the config here — that stability is
  // What makes stale detection (F9) work at all.
  const managedName = managedSessionName(
    path.basename(options.projectDir),
    sessionId(options.configPath, options.projectDir),
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
      if (!(await reapUnmarkedHost(deps, decision.name))) {
        deps.io.stderr(
          `Could not verify that managed tmux session ${decision.name} is stale. Check 'zaps ls' and retry after startup settles.\n`,
        );
        return { proceed: false, exitCode: 1 };
      }
      return launchManaged(deps, { ...options, name: decision.name, detach: decision.detach });
    }
    case "spawn":
    case "spawn-detached": {
      return launchManaged(deps, { ...options, name: decision.name });
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

export {
  DETACHED_HINT,
  MANAGED_BOOTSTRAP_FLAG,
  consumeManagedEnvironmentSnapshot,
  ensureTmuxContext,
  managedBootstrapReporter,
  reattachManaged,
};
export type { BootstrapDeps, BootstrapIo, BootstrapResult, BootstrapTmux, ManagedStartup };
