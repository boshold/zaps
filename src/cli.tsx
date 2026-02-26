#!/usr/bin/env node
import path from "node:path";

import type { IpcResponse } from "./lib/ipc/protocol.js";
import { program } from "commander";

import { DaemonClient } from "./client/daemon-client.js";
import { discoverConfig } from "./config/discovery.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { ensureDaemon, runDaemon } from "./daemon/index.js";
import { isDaemonRunning, socketPath } from "./daemon/lifecycle.js";
import { sessionId } from "./daemon/session.js";
import { getEnv } from "./lib/env.js";
import { ipcRequest, ipcStream } from "./lib/ipc/client.js";
import {
  currentPaneId,
  currentSession,
  killPane,
  listZapsSessions,
  selectPane,
  sendKeys,
  showEnv,
} from "./lib/tmux.js";

declare const __BUILD_TIME__: string;

function resolveCommand(): string {
  const zapsCommand = getEnv("ZAPS_COMMAND");
  if (zapsCommand) {
    return zapsCommand;
  }
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return path.basename(process.execPath);
  }
  return process.argv.slice(0, 2).join(" ");
}

function resolveRuntime(): string {
  const env = getEnv("ZAPS_RUNTIME");
  if (env) {
    return env;
  }
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return "native";
  }
  return "source";
}

program
  .name("zaps")
  .version(
    `0.1.0 (${resolveRuntime()}) built ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "from source"}`,
  )
  .description("Terminal session manager");

interface SessionInfo {
  id: string;
  name: string;
  projectDir: string;
}

function resolveTargetSession(sessions: SessionInfo[], sessionArg?: string): SessionInfo {
  if (sessionArg) {
    const found = sessions.find((s) => s.id === sessionArg || s.name === sessionArg);
    if (!found) {
      process.stderr.write(`Session not found: ${sessionArg}\n`);
      process.exit(1);
    }
    return found;
  }
  if (sessions.length === 1) {
    return sessions[0];
  }
  const cwd = process.cwd();
  const match = sessions.find((s) => s.projectDir === cwd);
  if (match) {
    return match;
  }
  process.stderr.write("Multiple sessions running. Specify one:\n");
  for (const s of sessions) {
    process.stderr.write(`  ${s.id}  ${s.name}  ${s.projectDir}\n`);
  }
  process.exit(1);
}

program
  .command("dev", { isDefault: true })
  .description("Launch zaps dev session")
  .action(async () => {
    const configPath = discoverConfig(process.cwd());
    if (!configPath) {
      process.stderr.write("No config found. Run `zaps init` to create one.\n");
      process.exit(1);
    }

    const invokeDir = process.cwd();

    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    const originPane = await currentPaneId();
    const tmuxSession = await currentSession();

    const command = resolveCommand();
    const sock = await ensureDaemon(command);

    const res = await ipcRequest(sock, "session.create", {
      configPath,
      projectDir: invokeDir,
      tmuxSession,
      originPane,
    });

    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }

    const session = res.result as { id: string; name: string; paneMap: Record<string, string> };
    const tuiPaneId = session.paneMap["@tui"];

    await selectPane(tuiPaneId);

    if (tuiPaneId === originPane) {
      await runTui({ sessionId: session.id, socketPath: sock, autoStart: true });
    } else {
      await sendKeys(
        tuiPaneId,
        `${command} ui --session ${session.id} --socket ${sock} --start; exit`,
      );
    }
  });

async function runTui(opts: {
  sessionId: string;
  socketPath: string;
  autoStart?: boolean;
}): Promise<void> {
  const client = new DaemonClient(opts.socketPath, opts.sessionId);
  client.connect();

  // Parallel: load yoga + attach to daemon (no config loading needed)
  const [yogaMod, snapshot] = await Promise.all([import("yoga-layout"), client.attach()]);
  await (yogaMod.default as unknown as Record<string, unknown>)["__yogaReady"];

  // Skip splash on reattach (services already running)
  const allStopped = snapshot.statuses.every((s) => s.state === "stopped");
  const showSplash = Boolean(opts.autoStart) && allStopped;

  process.stdout.write("\x1b[?1049h");

  if (showSplash) {
    const { renderSplash } = await import("./components/logo.js");
    const { listPanes } = await import("./lib/tmux.js");
    const tmuxSession = await currentSession();
    const panes = await listPanes(tmuxSession);
    const tuiPane = panes.find((p) => p.id === snapshot.paneMap["@tui"]);
    if (tuiPane) {
      renderSplash({ cols: tuiPane.width, rows: tuiPane.height });
    } else {
      renderSplash();
    }
  }

  // Parallel: load ink + App component
  const [{ render }, { App }] = await Promise.all([import("ink"), import("./components/App.js")]);

  const { waitUntilExit } = render(
    <App
      client={client}
      paneMap={snapshot.paneMap}
      projectName={snapshot.name}
      tasks={snapshot.tasks ?? []}
      servicesMeta={snapshot.servicesMeta ?? []}
      initialStatuses={snapshot.statuses}
      autoStart={showSplash}
    />,
    { patchConsole: false },
  );

  await waitUntilExit();

  process.stdout.write("\x1b[?1049l");
  client.disconnect();
}

program
  .command("ui")
  .description("Run zaps TUI (called by dev command)")
  .option("--start", "Start services before rendering TUI")
  .requiredOption("--session <id>", "Daemon session ID")
  .requiredOption("--socket <path>", "Daemon socket path")
  .action(async (opts: { start?: boolean; session: string; socket: string }) => {
    await runTui({ sessionId: opts.session, socketPath: opts.socket, autoStart: opts.start });
  });

program
  .command("attach [session]")
  .description("Attach to a running zaps session")
  .action(async (sessionArg?: string) => {
    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    const sock = socketPath();
    if (!isDaemonRunning()) {
      process.stderr.write("No running daemon found.\n");
      process.exit(1);
    }

    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }

    const sessions = res.result as { id: string; name: string; projectDir: string }[];
    if (sessions.length === 0) {
      process.stderr.write("No active sessions.\n");
      process.exit(1);
    }

    const targetSession = resolveTargetSession(sessions, sessionArg);
    await runTui({ sessionId: targetSession.id, socketPath: sock });
  });

program
  .command("sessions")
  .description("List running zaps instances")
  .action(async () => {
    const sock = socketPath();
    if (!isDaemonRunning()) {
      const sessions = await listZapsSessions();
      if (sessions.length === 0) {
        process.stdout.write("No running zaps instances found.\n");
        return;
      }
      for (const { session, panes } of sessions) {
        process.stdout.write(`${session} (${panes} panes)\n`);
      }
      return;
    }

    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    const sessions = res.result as { id: string; name: string; projectDir: string }[];
    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
      return;
    }
    for (const s of sessions) {
      process.stdout.write(`${s.id}  ${s.name}  ${s.projectDir}\n`);
    }
  });

program
  .command("init")
  .description("Create a starter .zaps.mts config")
  .action(async () => {
    const cwd = process.cwd();
    const existing = discoverConfig(cwd);
    if (existing) {
      process.stderr.write(`Config already exists: ${existing}\n`);
      process.exit(1);
    }
    const written = await scaffoldConfig(cwd);
    process.stdout.write(`Created ${written}\n`);
  });

// --- CLI session routing ---

interface SessionIpc {
  request(method: string, params?: unknown): Promise<IpcResponse>;
  stream(
    method: string,
    params: unknown,
    onEvent: (event: string, data: unknown) => void,
  ): Promise<IpcResponse>;
}

function resolveSessionId(): { configPath: string; id: string } {
  const cwd = process.cwd();
  const configPath = discoverConfig(cwd);
  if (!configPath) {
    process.stderr.write("No .zaps.mts config found. Run `zaps init` to create one.\n");
    process.exit(1);
  }
  return { configPath, id: sessionId(configPath) };
}

async function withDaemon<T>(fn: (ipc: SessionIpc) => Promise<T>): Promise<T> {
  const sock = socketPath();
  if (!isDaemonRunning()) {
    return withLegacyIpc(fn);
  }

  const { id } = resolveSessionId();

  const res = await ipcRequest(sock, "session.list");
  if (res.error) {
    process.stderr.write(`Error: ${res.error}\n`);
    process.exit(1);
  }
  const sessions = res.result as { id: string }[];
  const match = sessions.find((s) => s.id === id);
  if (!match) {
    process.stderr.write("No running zaps session for this project.\n");
    process.exit(1);
  }

  const ipc: SessionIpc = {
    request: async (method, params?) => ipcRequest(sock, method, params, 30_000, id),
    stream: async (method, params, onEvent) =>
      ipcStream(sock, method, params, onEvent, 120_000, id),
  };
  return fn(ipc);
}

async function withLegacyIpc<T>(fn: (ipc: SessionIpc) => Promise<T>): Promise<T> {
  if (!getEnv("TMUX")) {
    process.stderr.write("Must be inside a tmux session.\n");
    process.exit(1);
  }
  const tmuxSession = await currentSession();
  const legacySock = await showEnv(tmuxSession, "ZAPS_IPC_SOCKET");
  if (!legacySock) {
    process.stderr.write("No running zaps instance found in this session.\n");
    process.exit(1);
  }
  const ipc: SessionIpc = {
    request: async (method, params?) => ipcRequest(legacySock, method, params),
    stream: async (method, params, onEvent) => ipcStream(legacySock, method, params, onEvent),
  };
  return fn(ipc);
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const cols = rows[0].length;
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < cols; i += 1) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ")).join("\n");
}

program
  .command("services")
  .description("List services from running zaps instance")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await withDaemon(async (ipc) => {
      const res = await ipc.request("services.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
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
    });
  });

program
  .command("tasks")
  .description("List tasks from running zaps instance")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await withDaemon(async (ipc) => {
      const res = await ipc.request("tasks.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
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
    });
  });

const taskCmd = program.command("task").description("Task operations");

taskCmd
  .command("run <key>")
  .description("Run a task on the running zaps instance")
  .option("--json", "Output as JSON")
  .action(async (key: string, opts: { json?: boolean }) => {
    await withDaemon(async (ipc) => {
      const res = await ipc.stream("tasks.run", { key }, (event, data) => {
        if (!opts.json && event === "line") {
          process.stdout.write(`${data as string}\n`);
        }
      });
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        return;
      }
      const result = res.result as { success: boolean };
      if (!result.success) {
        process.stderr.write("Task failed.\n");
        process.exit(1);
      }
    });
  });

const serviceCmd = program.command("service").description("Service operations");

serviceCmd
  .command("details <name>")
  .description("Show service details")
  .option("--json", "Output as JSON")
  .action(async (name: string, opts: { json?: boolean }) => {
    await withDaemon(async (ipc) => {
      const res = await ipc.request("services.details", { name });
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        return;
      }
      const details = res.result as Record<string, unknown>;
      for (const [k, v] of Object.entries(details)) {
        const val = Array.isArray(v)
          ? v.join(", ") || "-"
          : v === null
            ? "-"
            : typeof v === "object"
              ? JSON.stringify(v)
              : `${v as string | number | boolean}`; // eslint-disable-line no-nested-ternary -- Compact value formatting
        process.stdout.write(`${k}: ${val}\n`);
      }
    });
  });

for (const action of ["start", "stop", "restart"] as const) {
  serviceCmd
    .command(`${action} <name>`)
    .description(`${action.charAt(0).toUpperCase()}${action.slice(1)} a service`)
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      await withDaemon(async (ipc) => {
        const res = await ipc.request(`services.${action}`, { name });
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        } else {
          process.stdout.write(`Service ${name} ${action}ed.\n`);
        }
      });
    });
}

program
  .command("down")
  .description("Stop all services and destroy session")
  .action(async () => {
    const sock = socketPath();
    if (isDaemonRunning()) {
      const { id } = resolveSessionId();
      const res = await ipcRequest(sock, "session.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      const sessions = res.result as { id: string }[];
      const match = sessions.find((s) => s.id === id);
      if (match) {
        const destroyRes = await ipcRequest(sock, "session.destroy", null, 30_000, id);
        if (destroyRes.error) {
          process.stderr.write(`Error: ${destroyRes.error}\n`);
        } else {
          process.stdout.write("Session destroyed.\n");
        }
      } else {
        process.stderr.write("No running zaps session for this project.\n");
      }
      return;
    }

    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    const tmuxSession = await currentSession();
    const raw = await showEnv(tmuxSession, "ZAPS_PANE_MAP");
    if (!raw) {
      process.stderr.write("No active zaps panes found in this session.\n");
      process.exit(1);
    }

    const paneMap = JSON.parse(raw) as Record<string, string>;
    const originPane = await currentPaneId();

    let killed = 0;
    for (const paneId of Object.values(paneMap)) {
      if (paneId !== originPane) {
        await killPane(paneId).catch(() => {
          /* Best-effort cleanup */
        });
        killed += 1;
      }
    }
    process.stdout.write(`Killed ${killed} pane(s).\n`);
  });

// --- Daemon management ---

const daemonCmd = program.command("daemon").description("Daemon management");

daemonCmd
  .command("run")
  .description("Run daemon in foreground (internal)")
  .action(async () => {
    await runDaemon();
  });

daemonCmd
  .command("start")
  .description("Start the background daemon")
  .action(async () => {
    if (isDaemonRunning()) {
      process.stdout.write("Daemon already running.\n");
      return;
    }
    const command = resolveCommand();
    await ensureDaemon(command);
    process.stdout.write("Daemon started.\n");
  });

daemonCmd
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    if (!isDaemonRunning()) {
      process.stdout.write("Daemon not running.\n");
      return;
    }
    const sock = socketPath();
    await ipcRequest(sock, "daemon.shutdown").catch(() => {
      /* Best-effort */
    });
    process.stdout.write("Daemon stopped.\n");
  });

daemonCmd
  .command("status")
  .description("Show daemon status")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    if (!isDaemonRunning()) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ running: false })}\n`);
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
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ running: true, ...(res.result as object) }, null, 2)}\n`,
      );
    } else {
      const status = res.result as { pid: number; sessions: { id: string; name: string }[] };
      process.stdout.write(`Daemon running (PID ${status.pid})\n`);
      process.stdout.write(`Sessions: ${status.sessions.length}\n`);
      for (const s of status.sessions) {
        process.stdout.write(`  ${s.id}  ${s.name}\n`);
      }
    }
  });

program.parse();
