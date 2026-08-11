#!/usr/bin/env node
import { cli, command } from "cleye";
import type { Command } from "cleye";

import { ensureTmuxContext, reattachManaged } from "./cli/bootstrap-tmux.js";
import { renderCliError } from "./cli/errors.js";
import type { SessionInfo, SessionIpc } from "./cli/helpers.js";
import {
  CliError,
  DAEMON_NOT_RUNNING,
  formatTable,
  parsePositiveInt,
  resolveCommand,
  resolveCommandArgv,
  resolveListedSessionId,
  resolveRuntime,
  resolveSessionId,
  resolveTargetSession,
  runDown,
  withDaemon,
} from "./cli/helpers.js";
import { isCodingAgent, resolveFormat, sessionRows, writeData } from "./cli/output.js";
import { refuseManagedMessage, refusePersonalMessage } from "./cli/tmux-context.js";
import { DaemonClient } from "./client/daemon-client.js";
import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { ensureDaemon, runDaemon } from "./daemon/index.js";
import { isDaemonRunning, socketPath } from "./daemon/lifecycle.js";
import { sessionId } from "./daemon/session.js";
import { getEnv } from "./lib/env.js";
import { ipcRequest, ipcSubscribe } from "./lib/ipc/client.js";
import type { IpcSubscription } from "./lib/ipc/client.js";
import type { DaemonEvent } from "./lib/ipc/protocol.js";
import { installResizeReset } from "./lib/screen-reset.js";
import type { ServiceStatus } from "./lib/service/types.js";
import { currentPaneId, currentSession, selectPane, sendKeys } from "./lib/tmux.js";

declare const __VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_BRANCH__: string;

const VERSION = `${typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"} (${resolveRuntime()}) built ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "from source"}${typeof __BUILD_BRANCH__ !== "undefined" ? ` [${__BUILD_BRANCH__}]` : ""}`;

// --- Global -s/--session (commander parity) ---

/**
 * Commander exposed a root-level `-s/--session` readable from every subcommand
 * via `program.opts()`, accepted both before and after the command name. cleye
 * has no inherited flags, so parity is kept with a thin adapter: leading
 * occurrences are hoisted off argv before dispatch, and every command declares
 * the same flag and folds its parsed value back in via `adoptGlobalSession`.
 */
let sessionOption: string | undefined = undefined;

function globalSession(): string | undefined {
  return sessionOption;
}

function adoptGlobalSession(session: string | undefined): void {
  if (session !== undefined) {
    sessionOption = session;
  }
}

/** Hoist leading `-s <v>` / `--session <v>` / `--session=<v>` off argv. */
function consumeLeadingSessionFlag(argv: string[]): string[] {
  const rest = [...argv];
  let consuming = true;
  while (consuming && rest.length > 0) {
    const [arg] = rest;
    if (arg === "-s" || arg === "--session") {
      if (rest.length < 2) {
        process.stderr.write("error: option '-s, --session <session>' argument missing\n");
        process.exit(1);
      }
      [, sessionOption] = rest;
      rest.splice(0, 2);
    } else if (arg.startsWith("--session=")) {
      sessionOption = arg.slice("--session=".length);
      rest.shift();
    } else {
      consuming = false;
    }
  }
  return rest;
}

const sessionFlag = {
  session: {
    type: String,
    alias: "s",
    placeholder: "<session>",
    description: "Target session by id/name prefix",
  },
};

const formatFlags = {
  json: { type: Boolean, description: "Output as JSON" },
  toon: { type: Boolean, description: "Output as TOON" },
};

/** Commander errors on excess command-arguments by default; keep that. */
function rejectExcessArgs(name: string, args: readonly string[], expected: number): void {
  if (args.length > expected) {
    process.stderr.write(
      `error: too many arguments for '${name}'. Expected ${expected} argument${expected === 1 ? "" : "s"} but got ${args.length}.\n`,
    );
    process.exit(1);
  }
}

// --- TUI ---

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdoutSize(): string {
  return `${String(process.stdout.columns)}x${String(process.stdout.rows)}`;
}

/**
 * Wait until the terminal size stops changing before the first Ink paint.
 *
 * Inside tmux, `zaps up` splits its service/log panes around launch, so the
 * `@tui` pane keeps resizing for a few hundred ms. Ink only clears the screen on
 * a width *decrease* (see ink `resized`/`shouldClearTerminalForFrame`), so a
 * first frame painted mid-resize — typically while the pane is still *growing*
 * into its final width — is left on screen as residue until a manual tmux resize
 * triggers a clear. Settling the size first lets us paint exactly once at the
 * final dimensions. Resolves fast (~150ms) when the size is already stable.
 */
async function waitForStableSize(maxMs = 1000, stableMs = 150, stepMs = 50): Promise<void> {
  if (!process.stdout.isTTY) {
    return;
  }
  let prev = readStdoutSize();
  let stableFor = 0;
  for (let waited = 0; waited < maxMs; waited += stepMs) {
    await sleep(stepMs);
    const cur = readStdoutSize();
    if (cur === prev) {
      stableFor += stepMs;
      if (stableFor >= stableMs) {
        return;
      }
    } else {
      stableFor = 0;
      prev = cur;
    }
  }
}

async function runTui(opts: {
  sessionId: string;
  socketPath: string;
  autoStart?: boolean;
}): Promise<void> {
  const client = new DaemonClient(opts.socketPath, opts.sessionId);
  client.connect();

  // Parallel: load yoga + attach to daemon (no config loading needed)
  const [yogaMod, snapshot] = await Promise.all([import("yoga-layout"), client.attach()]);
  await (yogaMod.default as unknown as Record<string, unknown>).__yogaReady;

  // Skip splash on reattach (services already running)
  const allStopped = snapshot.statuses.every((s) => s.state === "stopped");
  const showSplash = Boolean(opts.autoStart) && allStopped;

  process.stdout.write("\x1b[?1049h");

  if (showSplash) {
    const { managedSplashHint, renderSplash } = await import("./components/logo.js");
    const { resolveIconTier } = await import("./components/theme/IconTheme.js");
    const { listPanes } = await import("./lib/tmux.js");
    const splashTier = resolveIconTier(snapshot.ui?.icons);
    const hint = managedSplashHint(getEnv("ZAPS_MANAGED_TMUX"));
    const tmuxSession = await currentSession();
    const panes = await listPanes(tmuxSession);
    const tuiPane = panes.find((p) => p.id === snapshot.paneMap["@tui"]);
    if (tuiPane) {
      renderSplash({ cols: tuiPane.width, rows: tuiPane.height }, splashTier, hint);
    } else {
      renderSplash(undefined, splashTier, hint);
    }
  }

  // Parallel: load ink + App component
  const [{ render }, { App }] = await Promise.all([import("ink"), import("./components/App.js")]);

  // Let the pane size settle (after zaps' own pane splits), then clear so the
  // First frame paints once, clean, at the final size — no splash or mid-resize
  // Residue left behind for a manual tmux resize to mop up.
  await waitForStableSize();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }

  // Zaps keeps splitting/resizing the @tui pane after mount. Ink only force-
  // Clears on a width *decrease*, so growing into the final size leaves frame
  // Residue. Mop up the cases Ink misses; the live reflow then repaints clean.
  const stopResizeReset = installResizeReset(process.stdout);

  const { waitUntilExit } = render(
    <App
      client={client}
      paneMap={snapshot.paneMap}
      projectName={snapshot.name}
      tasks={snapshot.tasks ?? []}
      servicesMeta={snapshot.servicesMeta ?? []}
      initialStatuses={snapshot.statuses}
      initialTaskHistory={snapshot.taskHistory ?? []}
      autoStart={showSplash}
      configStale={snapshot.configStale}
      ui={snapshot.ui}
    />,
    { patchConsole: false },
  );

  await waitUntilExit();

  stopResizeReset();
  process.stdout.write("\x1b[?1049l");
  client.disconnect();
}

const DETACH_INACTIVITY_MS = 120_000;

/**
 * `zaps up -d`: subscribe to the session, then issue a SINGLE `services.startAll`
 * that joins the daemon's deduped in-flight run. Blocks until the run settles,
 * bounded by an inactivity timeout that resets on every subscription event (no
 * fixed wall-clock cap). Throws `CliError` on disconnect/inactivity; throws when
 * any service ended in `error` so the caller can exit non-zero.
 */
async function runDetachedStartAll(sock: string, sid: string, sessionName: string): Promise<void> {
  const ctl: {
    sub?: IpcSubscription;
    inactivity?: ReturnType<typeof setTimeout>;
    done: boolean;
    anyError: boolean;
  } = { done: false, anyError: false };

  await new Promise<void>((resolve, reject) => {
    const finish = (action: () => void): void => {
      if (ctl.done) {
        return;
      }
      ctl.done = true;
      if (ctl.inactivity) {
        clearTimeout(ctl.inactivity);
      }
      ctl.sub?.close();
      action();
    };
    const arm = (): void => {
      if (ctl.done) {
        return;
      }
      if (ctl.inactivity) {
        clearTimeout(ctl.inactivity);
      }
      ctl.inactivity = setTimeout(() => {
        finish(() =>
          reject(
            new CliError(
              `zaps up -d: no activity from the daemon for ${DETACH_INACTIVITY_MS / 1000}s; aborting.`,
            ),
          ),
        );
      }, DETACH_INACTIVITY_MS);
      ctl.inactivity.unref?.();
    };
    // Single startAll that joins the deduped in-flight run; no wall-clock cap
    // (0) — the inactivity timer and socket-close handler bound it instead.
    const drive = async (): Promise<void> => {
      await ctl.sub?.ready;
      const startRes = await ctl.sub?.request("services.startAll", undefined, 0);
      if (startRes?.error) {
        finish(() => reject(new CliError(`Error starting services: ${startRes.error}`)));
        return;
      }
      const listRes = await ctl.sub?.request("services.list", undefined, 0);
      const statuses = (listRes?.result as ServiceStatus[] | undefined) ?? [];
      ctl.anyError = statuses.some((s) => s.state === "error");
      finish(() => resolve());
    };

    ctl.sub = ipcSubscribe(
      sock,
      sid,
      ["service.stateChange", "log.lines"],
      () => {
        arm();
      },
      () => {
        finish(() => reject(new CliError("error: daemon connection closed")));
      },
      (err) => {
        finish(() => reject(new CliError(`Error starting services: ${err}`)));
      },
    );
    arm();
    void drive().catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });

  if (ctl.anyError) {
    throw new CliError(`Session ${sessionName}: one or more services failed to start.`);
  }
  process.stdout.write(`Session ${sessionName} started (detached).\n`);
}

async function upFlow(detach?: boolean): Promise<void> {
  const configPath = discoverConfig(process.cwd());
  if (!configPath) {
    process.stderr.write("No config found. Run `zaps init` to create one.\n");
    process.exit(1);
  }

  const invokeDir = process.cwd();

  // Outside tmux we never get here: `upCommand` bootstraps a managed session
  // First and only falls through once `$TMUX` is set.
  const originPane = await currentPaneId();
  const tmuxSession = await currentSession();

  const zapsCommand = resolveCommand();
  const sock = await ensureDaemon(resolveCommandArgv());

  const res = await ipcRequest(sock, "session.create", {
    configPath,
    projectDir: invokeDir,
    tmuxSession,
    originPane,
    tmuxSocket: getEnv("ZAPS_TMUX_SOCKET") ?? null,
    managedTmux: getEnv("ZAPS_MANAGED_TMUX") === "1",
  });

  if (res.error) {
    process.stderr.write(`Error: ${res.error}\n`);
    process.exit(1);
  }

  const session = res.result as {
    id: string;
    name: string;
    paneMap: Record<string, string>;
    focusPane?: string;
  };

  if (detach) {
    // Start services without attaching the TUI; block until the run settles.
    try {
      await runDetachedStartAll(sock, session.id, session.name);
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
    return;
  }

  const tuiPaneId = session.paneMap["@tui"];
  // Honor the daemon-computed focus (layout `focus: true`); defaults to @tui.
  // Without a focused leaf this matches the old unconditional select behavior.
  const focusPane = session.focusPane ?? tuiPaneId;

  if (tuiPaneId === originPane) {
    // The TUI render blocks until exit, so focus before handing the pane to Ink.
    await selectPane(focusPane);
    await runTui({ sessionId: session.id, socketPath: sock, autoStart: true });
  } else {
    await sendKeys(
      tuiPaneId,
      `${zapsCommand} ui --session ${session.id} --socket ${sock} --start; exit`,
    );
    await selectPane(focusPane);
  }
}

/**
 * Resolve this process's tmux context for `zaps` / `zaps up`. Outside tmux this
 * spawns (or re-attaches to, or refuses) the project's managed tmux session and
 * the caller exits with the returned code; inside tmux it proceeds unchanged.
 * A missing config fails here with the same message `upFlow` would print, so no
 * tmux session is ever created for a non-project directory.
 */
async function bootstrapTmux(
  detach: boolean,
): Promise<{ proceed: true } | { exitCode: number; proceed: false }> {
  const configPath = discoverConfig(process.cwd());
  if (!configPath) {
    process.stderr.write("No config found. Run `zaps init` to create one.\n");
    process.exit(1);
  }
  return ensureTmuxContext({ configPath, projectDir: process.cwd(), detach });
}

// --- Smart default: attach if running, else up ---

const upCommand = command(
  {
    name: "up",
    flags: {
      ...sessionFlag,
      detach: { type: Boolean, alias: "d", description: "Start without attaching TUI" },
    },
    help: { description: "Create session, start services, attach TUI" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("up", parsed._, 0);
    const opts = { detach: parsed.flags.detach };
    const sessionOpt = globalSession();
    if (sessionOpt && isDaemonRunning()) {
      const sock = socketPath();
      const res = await ipcRequest(sock, "session.list");
      if (!res.error) {
        const sessions = res.result as SessionInfo[];
        try {
          const target = resolveTargetSession(sessions, sessionOpt);
          const configPath = discoverConfig(process.cwd());
          if (configPath) {
            const cwdId = sessionId(configPath);
            if (target.id !== cwdId) {
              process.stderr.write(
                `Session "${target.name}" is from a different project. Use \`zaps attach -s ${sessionOpt}\` instead.\n`,
              );
              process.exit(1);
            }
          }
        } catch (error) {
          if (error instanceof CliError) {
            renderCliError(error);
          }
          throw error;
        }
      }
    }

    // Outside tmux, hand over to a zaps-managed tmux session (or refuse) before
    // Anything else runs; inside tmux this falls straight through.
    const bootstrap = await bootstrapTmux(Boolean(opts.detach));
    if (!bootstrap.proceed) {
      // `process.exitCode` + return, never `process.exit()`: the bootstrap has
      // Just written user-facing lines, and exiting outright discards whatever
      // Is still buffered on a piped stdout/stderr.
      process.exitCode = bootstrap.exitCode;
      return;
    }

    // Smart default: if session already running for this project, attach
    if (!opts.detach && isDaemonRunning()) {
      const configPath = discoverConfig(process.cwd());
      if (configPath) {
        const sock = socketPath();
        const res = await ipcRequest(sock, "session.list");
        if (!res.error) {
          const sessions = res.result as SessionInfo[];
          const id = sessionId(configPath);
          const match = sessions.find((s) => s.id === id);
          if (match) {
            await runTui({ sessionId: match.id, socketPath: sock });
            return;
          }
        }
      }
    }

    await upFlow(opts.detach);
  },
);

// --- Core Lifecycle ---

const downCommand = command(
  {
    name: "down",
    flags: { ...sessionFlag },
    help: { description: "Stop all services and destroy session" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("down", parsed._, 0);
    const code = await runDown({
      daemonRunning: isDaemonRunning,
      socket: socketPath,
      sessionArg: globalSession(),
      listSessions: async (sock) => ipcRequest(sock, "session.list"),
      destroy: async (sock, id) => ipcRequest(sock, "session.destroy", null, 30_000, id),
      resolveProjectSessionId: () => resolveSessionId().id,
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    });
    if (code !== 0) {
      process.exit(code);
    }
  },
);

// --- Service Operations (flat, variadic) ---

function serviceActionCommand(action: "start" | "stop" | "restart") {
  return command(
    {
      name: action,
      parameters: ["[services...]"],
      flags: { ...sessionFlag, ...formatFlags },
      help: {
        description: `${action.charAt(0).toUpperCase()}${action.slice(1)} service(s). All if omitted`,
      },
    },
    async (parsed) => {
      adoptGlobalSession(parsed.flags.session);
      const { services } = parsed._;
      const opts = parsed.flags;
      try {
        await withDaemon(async (ipc) => {
          const params = services.length > 0 ? { names: services } : undefined;
          const res = await ipc.request(`services.${action}All`, params);
          if (res.error) {
            process.stderr.write(`Error: ${res.error}\n`);
            process.exit(1);
          }
          const format = resolveFormat(opts);
          if (format !== "text") {
            writeData(res.result, format);
          } else {
            const target = services.length > 0 ? services.join(", ") : "all services";
            process.stdout.write(
              `${action.charAt(0).toUpperCase()}${action.slice(1)}ed ${target}.\n`,
            );
          }
        }, globalSession());
      } catch (error) {
        if (error instanceof CliError) {
          renderCliError(error);
        }
        throw error;
      }
    },
  );
}

const startCommand = serviceActionCommand("start");
const stopCommand = serviceActionCommand("stop");
const restartCommand = serviceActionCommand("restart");

// --- Query ---

const psCommand = command(
  {
    name: "ps",
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "List services and their status" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("ps", parsed._, 0);
    const opts = parsed.flags;
    try {
      await withDaemon(async (ipc) => {
        const res = await ipc.request("services.list");
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        const format = resolveFormat(opts);
        if (format !== "text") {
          writeData(res.result, format);
          return;
        }
        const statuses = res.result as {
          name: string;
          state: string;
          ports: number[];
          url?: string;
        }[];
        if (statuses.length === 0) {
          process.stdout.write("No services configured.\n");
          return;
        }
        const rows = [["NAME", "STATE", "PORTS", "URL"]];
        for (const s of statuses) {
          rows.push([s.name, s.state, s.ports.join(",") || "-", s.url ?? "-"]);
        }
        process.stdout.write(`${formatTable(rows)}\n`);
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const lsCommand = command(
  {
    name: "ls",
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "List active sessions" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("ls", parsed._, 0);
    const opts = parsed.flags;
    const format = resolveFormat(opts);
    const sock = socketPath();
    // No daemon → no sessions can exist; report it (E7) and emit an empty list
    // For machine formats. Informational, so exit 0 (nothing errored).
    if (!isDaemonRunning()) {
      if (format !== "text") {
        writeData([] as SessionInfo[], format);
        return;
      }
      process.stdout.write(`${DAEMON_NOT_RUNNING}\n`);
      return;
    }

    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    const sessions = res.result as SessionInfo[];
    if (format !== "text") {
      writeData(sessions, format);
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
      return;
    }
    process.stdout.write(`${formatTable(sessionRows(sessions))}\n`);
  },
);

const inspectCommand = command(
  {
    name: "inspect",
    parameters: ["<service>"],
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "Show service details" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("inspect", parsed._, 1);
    const name = parsed._.service;
    const opts = parsed.flags;
    try {
      await withDaemon(async (ipc) => {
        const res = await ipc.request("services.details", { name });
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        const format = resolveFormat(opts);
        if (format !== "text") {
          writeData(res.result, format);
          return;
        }
        const details = res.result as Record<string, unknown>;
        for (const [k, v] of Object.entries(details)) {
          let val = "";
          if (Array.isArray(v)) {
            val = v.join(", ") || "-";
          } else if (v === null) {
            val = "-";
          } else if (typeof v === "object") {
            val = JSON.stringify(v);
          } else {
            val = `${v as string | number | boolean}`;
          }
          process.stdout.write(`${k}: ${val}\n`);
        }
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

// --- New Commands ---

const SERVICE_COLORS = [
  "\x1b[36m", // Cyan
  "\x1b[33m", // Yellow
  "\x1b[35m", // Magenta
  "\x1b[32m", // Green
  "\x1b[34m", // Blue
  "\x1b[91m", // Bright red
];
const RESET = "\x1b[0m";

const logsCommand = command(
  {
    name: "logs",
    parameters: ["[services...]"],
    flags: {
      ...sessionFlag,
      follow: { type: Boolean, alias: "f", description: "Stream live logs" },
      tail: {
        type: String,
        default: "100",
        placeholder: "<n>",
        description: "Number of lines to show",
      },
    },
    help: { description: "Dump log buffer. -f to stream live" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    const { services } = parsed._;
    const opts = parsed.flags;
    const tail = parsePositiveInt(opts.tail);
    if (tail === null) {
      process.stderr.write(`Invalid --tail value "${opts.tail}": expected a positive integer.\n`);
      process.exit(1);
    }

    try {
      await withDaemon(async (ipc: SessionIpc) => {
        // Get service list if none specified
        let targetServices = services;
        if (targetServices.length === 0) {
          const listRes = await ipc.request("services.list");
          if (listRes.error) {
            process.stderr.write(`Error: ${listRes.error}\n`);
            process.exit(1);
          }
          targetServices = (listRes.result as { name: string }[]).map((s) => s.name);
        }

        const multiService = targetServices.length > 1;
        const colorMap = new Map<string, string>();
        for (let i = 0; i < targetServices.length; i += 1) {
          colorMap.set(targetServices[i], SERVICE_COLORS[i % SERVICE_COLORS.length]);
        }

        // Compute max service name length for padding
        const maxLen = Math.max(...targetServices.map((s) => s.length));

        function formatLine(service: string, line: string): string {
          if (!multiService) {
            return line;
          }
          const color = colorMap.get(service) ?? "";
          return `${color}${service.padEnd(maxLen)}${RESET} | ${line}`;
        }

        // Snapshot: get last N lines per service
        for (const svc of targetServices) {
          const snapRes = await ipc.request("logs.snapshot", { service: svc });
          if (snapRes.error) {
            process.stderr.write(`Error (${svc}): ${snapRes.error}\n`);
            continue; // eslint-disable-line no-continue -- Skip failed services
          }
          const lines = snapRes.result as string[];
          const sliced = lines.slice(-tail);
          for (const line of sliced) {
            process.stdout.write(`${formatLine(svc, line)}\n`);
          }
        }

        if (!opts.follow) {
          return;
        }

        // Follow mode: subscribe to log events
        const sock = socketPath();
        let userClosed = false;
        const sub = ipcSubscribe(
          sock,
          ipc.sessionId,
          ["log.lines"],
          (event: DaemonEvent) => {
            const data = event.data as { service: string; lines: string[] };
            if (targetServices.includes(data.service)) {
              for (const line of data.lines) {
                process.stdout.write(`${formatLine(data.service, line)}\n`);
              }
            }
          },
          () => {
            // Q5: the daemon closed the socket — no reconnect; report and exit 1.
            if (!userClosed) {
              process.stderr.write("error: daemon connection closed\n");
              process.exit(1);
            }
          },
        );

        // Wait for ctrl+c
        await new Promise<void>((resolve) => {
          process.on("SIGINT", () => {
            userClosed = true;
            sub.close();
            resolve();
          });
        });
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const runCommand = command(
  {
    name: "run",
    parameters: ["<task>"],
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "Run a task" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("run", parsed._, 1);
    const key = parsed._.task;
    const opts = parsed.flags;
    try {
      const format = resolveFormat(opts);
      await withDaemon(async (ipc) => {
        const res = await ipc.stream("tasks.run", { key }, (event, data) => {
          if (format === "text" && event === "line") {
            process.stdout.write(`${data as string}\n`);
          }
        });
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        if (format !== "text") {
          writeData(res.result, format);
          return;
        }
        const result = res.result as { success: boolean };
        if (!result.success) {
          process.stderr.write("Task failed.\n");
          process.exit(1);
        }
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const eventsCommand = command(
  {
    name: "events",
    flags: {
      ...sessionFlag,
      filter: { type: String, placeholder: "<type>", description: "Filter events by type (regex)" },
    },
    help: { description: "Stream daemon events as ndjson" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("events", parsed._, 0);
    const opts = parsed.flags;
    const sock = socketPath();

    if (!isDaemonRunning()) {
      process.stderr.write(`${DAEMON_NOT_RUNNING}\n`);
      process.exit(1);
    }

    // Validate the resolved session against session.list up front (E8) — the
    // No-`-s` path resolves a pure config hash, so without this check `events`
    // Would subscribe to a nonexistent session and hang forever.
    const id = await (async () => {
      try {
        const res = await ipcRequest(sock, "session.list");
        if (res.error) {
          throw new CliError(`Error: ${res.error}`);
        }
        const sessions = res.result as SessionInfo[];
        return resolveListedSessionId(sessions, globalSession());
      } catch (error) {
        if (error instanceof CliError) {
          renderCliError(error);
        }
        throw error;
      }
    })();

    const filterRe = opts.filter ? new RegExp(opts.filter) : null;

    let userClosed = false;
    const sub = ipcSubscribe(
      sock,
      id,
      [],
      (event: DaemonEvent) => {
        if (filterRe && !filterRe.test(event.event)) {
          return;
        }
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
      () => {
        // Q5: the daemon closed the socket — no reconnect; report and exit 1.
        if (!userClosed) {
          process.stderr.write("error: daemon connection closed\n");
          process.exit(1);
        }
      },
      (reason: string) => {
        // E8: surface a subscribe error-ack that slipped past the session.list pre-check.
        process.stderr.write(`error: ${reason}\n`);
        process.exit(1);
      },
    );

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        userClosed = true;
        sub.close();
        resolve();
      });
    });
  },
);

const configCommand = command(
  {
    name: "config",
    flags: {
      ...sessionFlag,
      ...formatFlags,
      path: { type: Boolean, description: "Print config file path only" },
    },
    help: { description: "Validate and print resolved config" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("config", parsed._, 0);
    const opts = parsed.flags;
    const configPath = discoverConfig(process.cwd());
    if (!configPath) {
      process.stderr.write("No config found. Run `zaps init` to create one.\n");
      process.exit(1);
    }

    if (opts.path) {
      process.stdout.write(`${configPath}\n`);
      return;
    }

    const config = await loadConfig(configPath).catch((error: unknown) => renderCliError(error));

    const format = resolveFormat(opts);
    if (format !== "text") {
      const output = {
        configPath: config.configPath,
        projectDir: config.projectDir,
        name: config.project.name,
        services: Object.fromEntries(
          Object.entries(config.project.services).map(([name, svc]) => [
            name,
            {
              dependsOn: svc.dependsOn ?? [],
              hasDocker: Boolean(svc.docker),
              detached: svc.detached ?? false,
            },
          ]),
        ),
        tasks: config.project.tasks
          ? Object.fromEntries(
              Object.entries(config.project.tasks).map(([key, t]) => [
                key,
                { name: t.name, description: t.description ?? null },
              ]),
            )
          : {},
      };
      writeData(output, format);
      return;
    }

    process.stdout.write(`Config: ${config.configPath}\n`);
    process.stdout.write(`Project: ${config.project.name}\n`);
    process.stdout.write(`Dir: ${config.projectDir}\n`);
    process.stdout.write("\nServices:\n");
    for (const [name, svc] of Object.entries(config.project.services)) {
      const deps = svc.dependsOn?.join(", ") || "none";
      const flags: string[] = [];
      if (svc.docker) {
        flags.push("docker");
      }
      if (svc.detached) {
        flags.push("detached");
      }
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      process.stdout.write(`  ${name}${flagStr}  deps: ${deps}\n`);
    }
    if (config.project.tasks) {
      process.stdout.write("\nTasks:\n");
      for (const [key, t] of Object.entries(config.project.tasks)) {
        process.stdout.write(`  ${key}  ${t.name}\n`);
      }
    }
  },
);

const primeAgentCommand = command(
  {
    name: "prime-agent",
    flags: { ...sessionFlag },
    help: { description: "Print project overview for AI agent priming" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("prime-agent", parsed._, 0);
    try {
      await withDaemon(async (ipc) => {
        const [svcRes, taskRes] = await Promise.all([
          ipc.request("services.list"),
          ipc.request("tasks.list"),
        ]);
        if (svcRes.error) {
          process.stderr.write(`Error: ${svcRes.error}\n`);
          process.exit(1);
        }
        if (taskRes.error) {
          process.stderr.write(`Error: ${taskRes.error}\n`);
          process.exit(1);
        }

        const services = (
          svcRes.result as {
            name: string;
            state: string;
            ports: number[];
            url?: string;
          }[]
        ).map((s) => ({
          name: s.name,
          state: s.state,
          ports: s.ports,
        }));

        const tasks = (
          taskRes.result as {
            key: string;
            name: string;
            description: string | null;
          }[]
        ).map((t) => ({
          key: t.key,
          name: t.name,
          description: t.description,
        }));

        writeData({ services, tasks }, "toon");
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const reloadCommand = command(
  {
    name: "reload",
    flags: { ...sessionFlag },
    help: { description: "Reload config for running session" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("reload", parsed._, 0);
    try {
      await withDaemon(async (ipc) => {
        const res = await ipc.request("session.reload");
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        process.stdout.write("Config reloaded.\n");
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

// --- Kept As-Is ---

const initCommand = command(
  {
    name: "init",
    flags: { ...sessionFlag },
    help: { description: "Create a starter .zaps.mts config" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("init", parsed._, 0);
    const cwd = process.cwd();
    const existing = discoverConfig(cwd);
    if (existing) {
      process.stderr.write(`Config already exists: ${existing}\n`);
      process.exit(1);
    }
    const written = await scaffoldConfig(cwd);
    process.stdout.write(`Created ${written}\n`);
  },
);

/**
 * Why `zaps attach` cannot reach `session`, if it cannot (F6/F7), as the message
 * to print. Attach never creates or moves anything, so both conflicts are hard
 * refusals — the user picks a terminal, or runs `zaps down`.
 */
async function attachConflict(session: SessionInfo): Promise<string | undefined> {
  const view = {
    name: session.name,
    tmuxSession: session.tmuxSession ?? "",
    managed: session.managed === true,
  };
  if (!getEnv("TMUX")) {
    // Outside tmux: a session in the user's own tmux is only reachable there.
    return view.managed ? undefined : refusePersonalMessage(view);
  }
  if (!view.managed) {
    return undefined;
  }
  // Inside tmux: fine when this IS the managed session (the TUI attaches in the
  // Current pane); refuse from any other tmux, where pane ops would target the
  // Wrong server.
  const current = await currentSession().catch(() => undefined);
  return current === view.tmuxSession ? undefined : refuseManagedMessage(view);
}

const attachCommand = command(
  {
    name: "attach",
    flags: { ...sessionFlag },
    help: { description: "Attach to a running zaps session" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("attach", parsed._, 0);

    const sock = socketPath();
    if (!isDaemonRunning()) {
      process.stderr.write(`${DAEMON_NOT_RUNNING}\n`);
      process.exit(1);
    }

    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }

    const sessions = res.result as SessionInfo[];
    if (sessions.length === 0) {
      process.stderr.write("No active sessions.\n");
      process.exit(1);
    }

    try {
      const targetSession = resolveTargetSession(sessions, globalSession());
      const conflict = await attachConflict(targetSession);
      if (conflict) {
        process.stderr.write(`${conflict}\n`);
        // Exit via the code so the multi-line hint is flushed first.
        process.exitCode = 1;
        return;
      }
      if (!getEnv("TMUX")) {
        // Plain terminal, managed session: revive its TUI pane and attach (F3).
        const result = await reattachManaged({
          name: targetSession.tmuxSession ?? "",
          tuiPane: targetSession.tuiPane ?? null,
        });
        // See the `up` bootstrap: exit via the code, so buffered output flushes.
        process.exitCode = result.proceed ? 0 : result.exitCode;
        return;
      }
      await runTui({ sessionId: targetSession.id, socketPath: sock });
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const tasksCommand = command(
  {
    name: "tasks",
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "List tasks" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("tasks", parsed._, 0);
    const opts = parsed.flags;
    try {
      await withDaemon(async (ipc) => {
        const res = await ipc.request("tasks.list");
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        const format = resolveFormat(opts);
        if (format !== "text") {
          writeData(res.result, format);
          return;
        }
        const tasks = res.result as { key: string; name: string; description: string | null }[];
        if (tasks.length === 0) {
          process.stdout.write("No tasks configured.\n");
          return;
        }
        const rows = [["KEY", "NAME", "DESCRIPTION"]];
        for (const t of tasks) {
          rows.push([t.key, t.name, t.description ?? "-"]);
        }
        process.stdout.write(`${formatTable(rows)}\n`);
      }, globalSession());
    } catch (error) {
      if (error instanceof CliError) {
        renderCliError(error);
      }
      throw error;
    }
  },
);

const uiCommand = command(
  {
    name: "ui",
    flags: {
      start: { type: Boolean, description: "Start services before rendering TUI" },
      session: { type: String, placeholder: "<id>", description: "Daemon session ID" },
      socket: { type: String, placeholder: "<path>", description: "Daemon socket path" },
    },
    help: { description: "Run zaps TUI (internal)" },
  },
  async (parsed) => {
    rejectExcessArgs("ui", parsed._, 0);
    const opts = parsed.flags;
    if (opts.session === undefined) {
      process.stderr.write("error: required option '--session <id>' not specified\n");
      process.exit(1);
    }
    if (opts.socket === undefined) {
      process.stderr.write("error: required option '--socket <path>' not specified\n");
      process.exit(1);
    }
    await runTui({ sessionId: opts.session, socketPath: opts.socket, autoStart: opts.start });
  },
);

const execServiceCommand = command(
  {
    name: "exec-service",
    parameters: ["<name>"],
    flags: { ...sessionFlag },
    help: { description: "Execute a service via wrapper (internal)" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("exec-service", parsed._, 1);
    const { name } = parsed._;
    const session = globalSession();
    if (!session) {
      process.stderr.write("Error: -s/--session is required for exec-service\n");
      process.exit(1);
    }
    const { execService } = await import("./cli/exec-service.js");
    await execService(name, session);
  },
);

const execTaskCommand = command(
  {
    name: "exec-task",
    parameters: ["<runId>"],
    flags: { ...sessionFlag },
    help: { description: "Execute a run-in-pane task via wrapper (internal)" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("exec-task", parsed._, 1);
    const { runId } = parsed._;
    const session = globalSession();
    if (!session) {
      process.stderr.write("Error: -s/--session is required for exec-task\n");
      process.exit(1);
    }
    const { execTask } = await import("./cli/exec-task.js");
    await execTask(runId, session);
  },
);

// --- Daemon management ---

const daemonRunCommand = command(
  {
    name: "run",
    flags: { ...sessionFlag },
    help: { description: "Run daemon in foreground (internal)" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("run", parsed._, 0);
    await runDaemon();
  },
);

const daemonStartCommand = command(
  {
    name: "start",
    flags: { ...sessionFlag },
    help: { description: "Start the background daemon" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("start", parsed._, 0);
    if (isDaemonRunning()) {
      process.stdout.write("Daemon already running.\n");
      return;
    }
    await ensureDaemon(resolveCommandArgv());
    process.stdout.write("Daemon started.\n");
  },
);

const daemonStopCommand = command(
  {
    name: "stop",
    flags: { ...sessionFlag },
    help: { description: "Stop the background daemon" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("stop", parsed._, 0);
    if (!isDaemonRunning()) {
      process.stdout.write("Daemon not running.\n");
      return;
    }
    const sock = socketPath();

    // Gather counts before issuing shutdown so we can report what was torn down.
    let sessionCount = 0;
    let serviceCount = 0;
    const statusRes = await ipcRequest(sock, "daemon.status").catch(() => null);
    if (statusRes && !statusRes.error) {
      const status = statusRes.result as { sessions: { serviceCount: number }[] };
      sessionCount = status.sessions.length;
      serviceCount = status.sessions.reduce((sum, s) => sum + s.serviceCount, 0);
    }

    await ipcRequest(sock, "daemon.shutdown").catch(() => {
      /* Best-effort — daemon may close the socket as it tears down */
    });

    // The daemon removes its pid/socket as part of handling the shutdown, so
    // Wait for that to actually happen before reporting — makes `daemon stop`
    // Deterministic (the command returns only once the daemon is really gone).
    const deadline = Date.now() + 5000;
    /* eslint-disable no-await-in-loop -- sequential poll for teardown completion */
    while (isDaemonRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    /* eslint-enable no-await-in-loop */

    process.stdout.write(`Stopped ${sessionCount} session(s), ${serviceCount} service(s).\n`);
  },
);

const daemonStatusCommand = command(
  {
    name: "status",
    flags: { ...sessionFlag, ...formatFlags },
    help: { description: "Show daemon status" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("status", parsed._, 0);
    const opts = parsed.flags;
    const format = resolveFormat(opts);
    if (!isDaemonRunning()) {
      if (format !== "text") {
        writeData({ running: false }, format);
      } else {
        process.stdout.write("Daemon not running.\n");
      }
      return;
    }
    const sock = socketPath();
    const res = await ipcRequest(sock, "daemon.status");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    if (format !== "text") {
      writeData({ running: true, ...(res.result as object) }, format);
    } else {
      const status = res.result as { pid: number; sessions: { id: string; name: string }[] };
      process.stdout.write(`Daemon running (PID ${status.pid})\n`);
      process.stdout.write(`Sessions: ${status.sessions.length}\n`);
      for (const s of status.sessions) {
        process.stdout.write(`  ${s.id}  ${s.name}\n`);
      }
    }
  },
);

const daemonPingCommand = command(
  {
    name: "ping",
    flags: { ...sessionFlag },
    help: { description: "Check if daemon is responsive" },
  },
  async (parsed) => {
    adoptGlobalSession(parsed.flags.session);
    rejectExcessArgs("ping", parsed._, 0);
    if (!isDaemonRunning()) {
      process.stderr.write("Daemon not running.\n");
      process.exit(1);
    }
    const sock = socketPath();
    const res = await ipcRequest(sock, "daemon.ping");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`${res.result as string}\n`);
  },
);

/**
 * `daemon` is a nested command group; cleye commands are flat, so the group is
 * dispatched as its own cleye instance on the remaining argv.
 */
function runDaemonCli(rawArgv: string[]): void {
  const argv = consumeLeadingSessionFlag(rawArgv);
  void cli(
    {
      name: "zaps daemon",
      commands: [
        daemonRunCommand,
        daemonStartCommand,
        daemonStopCommand,
        daemonStatusCommand,
        daemonPingCommand,
      ],
      flags: { ...sessionFlag },
      help: { description: "Daemon management" },
      strictFlags: true,
    },
    (parsed) => {
      adoptGlobalSession(parsed.flags.session);
      const [unknownCommand] = parsed._;
      if (unknownCommand !== undefined) {
        process.stderr.write(`error: unknown command '${unknownCommand}'\n`);
        process.exit(1);
      }
      parsed.showHelp();
      process.exit(1);
    },
    argv,
  );
}

/** Listed in root help only; dispatch is intercepted in `runRootCli`. */
const daemonGroupCommand = command({
  name: "daemon",
  help: { description: "Daemon management" },
});

const mcpCommand = command(
  {
    name: "mcp",
    flags: {
      session: {
        type: String,
        alias: "s",
        placeholder: "<id>",
        description: "Target session (auto-detected from CWD)",
      },
    },
    help: { description: "Start MCP server for AI tool integration" },
  },
  async (parsed) => {
    rejectExcessArgs("mcp", parsed._, 0);
    const sock = socketPath();
    // Session binding is resolved per tool call inside the server (E9) — not
    // Cached here — so an MCP server started before `zaps up`, or surviving a
    // Session restart, picks up the current session on the next call.
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer(sock, parsed.flags.session);
  },
);

const rootCommands: Command[] = [
  upCommand,
  downCommand,
  startCommand,
  stopCommand,
  restartCommand,
  psCommand,
  lsCommand,
  inspectCommand,
  logsCommand,
  runCommand,
  eventsCommand,
  configCommand,
  primeAgentCommand,
  reloadCommand,
  initCommand,
  attachCommand,
  tasksCommand,
  uiCommand,
  execServiceCommand,
  execTaskCommand,
  daemonGroupCommand,
  mcpCommand,
];

/** Commands omitted from `--help`; still invocable directly. */
function hiddenCommandNames(): Set<string> {
  const hidden = new Set(["ui", "exec-service", "exec-task"]);
  if (!isCodingAgent()) {
    hidden.add("prime-agent");
  }
  return hidden;
}

function runRootCli(argv: string[]): void {
  if (argv[0] === "daemon") {
    runDaemonCli(argv.slice(1));
    return;
  }
  void cli(
    {
      name: "zaps",
      commands: rootCommands,
      flags: {
        ...sessionFlag,
        version: { type: Boolean, alias: "V", description: "output the version number" },
      },
      help: {
        description: "Terminal session manager",
        render: (nodes, renderers) => {
          const hidden = hiddenCommandNames();
          for (const node of nodes) {
            if (node.id === "commands") {
              const section = node.data as { body: { data: { tableData: string[][] } } };
              section.body.data.tableData = section.body.data.tableData.filter(
                (row) => !hidden.has(row[0]),
              );
            }
          }
          return renderers.render(nodes);
        },
      },
      strictFlags: true,
    },
    (parsed) => {
      if (parsed.flags.version) {
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
      }
      adoptGlobalSession(parsed.flags.session);
      const [unknownCommand] = parsed._;
      if (unknownCommand !== undefined) {
        process.stderr.write(`error: unknown command '${unknownCommand}'\n`);
        process.exit(1);
      }
      parsed.showHelp();
      process.exit(1);
    },
    argv,
  );
}

// Registered last (matching commander's implicit trailing `help [command]`)
// And defined after `runRootCli` so it can re-dispatch `<cmd> --help`.
const helpCommand = command(
  {
    name: "help",
    parameters: ["[command]"],
    help: { description: "display help for command" },
  },
  (parsed) => {
    rejectExcessArgs("help", parsed._, 1);
    const target = parsed._.command;
    if (target === undefined) {
      runRootCli(["--help"]);
      return;
    }
    if (rootCommands.some((c) => c.options.name === target)) {
      runRootCli([target, "--help"]);
      return;
    }
    process.stderr.write(`error: unknown command '${target}'\n`);
    process.exit(1);
  },
);
rootCommands.push(helpCommand);

if (process.argv.length === 2) {
  process.argv.push("up");
}

runRootCli(consumeLeadingSessionFlag(process.argv.slice(2)));
