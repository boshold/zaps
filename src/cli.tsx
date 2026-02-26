#!/usr/bin/env node
import path from "node:path";

import type { DaemonEvent, IpcResponse } from "./lib/ipc/protocol.js";
import { program } from "commander";

import { DaemonClient } from "./client/daemon-client.js";
import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { ensureDaemon, runDaemon } from "./daemon/index.js";
import { isDaemonRunning, socketPath } from "./daemon/lifecycle.js";
import { sessionId } from "./daemon/session.js";
import { getEnv } from "./lib/env.js";
import { ipcRequest, ipcStream, ipcSubscribe } from "./lib/ipc/client.js";
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
  .description("Terminal session manager")
  .option("-s, --session <session>", "Target session by id/name prefix");

function globalSession(): string | undefined {
  return program.opts().session as string | undefined;
}

interface SessionInfo {
  id: string;
  name: string;
  projectDir: string;
}

function resolveTargetSession(sessions: SessionInfo[], sessionArg?: string): SessionInfo {
  if (sessionArg) {
    // Priority: exact id → exact name → id prefix → name prefix
    const exactId = sessions.find((s) => s.id === sessionArg);
    if (exactId) {
      return exactId;
    }
    const exactName = sessions.find((s) => s.name === sessionArg);
    if (exactName) {
      return exactName;
    }
    const prefixMatches = sessions.filter(
      (s) => s.id.startsWith(sessionArg) || s.name.startsWith(sessionArg),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
    if (prefixMatches.length > 1) {
      process.stderr.write(`Ambiguous session "${sessionArg}". Matches:\n`);
      for (const s of prefixMatches) {
        process.stderr.write(`  ${s.id}  ${s.name}  ${s.projectDir}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(`Session not found: ${sessionArg}\n`);
    process.exit(1);
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

// --- TUI ---

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
      initialTaskHistory={snapshot.taskHistory ?? []}
      autoStart={showSplash}
    />,
    { patchConsole: false },
  );

  await waitUntilExit();

  process.stdout.write("\x1b[?1049l");
  client.disconnect();
}

async function upFlow(detach?: boolean): Promise<void> {
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

  if (detach) {
    // Start services but don't attach TUI
    const startRes = await ipcRequest(sock, "services.startAll", null, 60_000, session.id);
    if (startRes.error) {
      process.stderr.write(`Error starting services: ${startRes.error}\n`);
      process.exit(1);
    }
    process.stdout.write(`Session ${session.name} started (detached).\n`);
    return;
  }

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
}

// --- Smart default: attach if running, else up ---

program
  .command("up")
  .description("Create session, start services, attach TUI")
  .option("-d, --detach", "Start without attaching TUI")
  .action(async (opts: { detach?: boolean }) => {
    const sessionOpt = globalSession();
    if (sessionOpt && isDaemonRunning()) {
      const sock = socketPath();
      const res = await ipcRequest(sock, "session.list");
      if (!res.error) {
        const sessions = res.result as SessionInfo[];
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
      }
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
            if (!getEnv("TMUX")) {
              process.stderr.write("zaps must be run from inside a tmux session.\n");
              process.exit(1);
            }
            await runTui({ sessionId: match.id, socketPath: sock });
            return;
          }
        }
      }
    }

    await upFlow(opts.detach);
  });

// --- Core Lifecycle ---

program
  .command("down")
  .description("Stop all services and destroy session")
  .action(async () => {
    const sock = socketPath();
    if (isDaemonRunning()) {
      const sessionOpt = globalSession();
      const res = await ipcRequest(sock, "session.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      const sessions = res.result as SessionInfo[];
      const target = sessionOpt
        ? resolveTargetSession(sessions, sessionOpt)
        : sessions.find((s) => s.id === resolveSessionId().id);
      if (target) {
        const destroyRes = await ipcRequest(sock, "session.destroy", null, 30_000, target.id);
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

// --- Service Operations (flat, variadic) ---

for (const action of ["start", "stop", "restart"] as const) {
  program
    .command(`${action} [services...]`)
    .description(`${action.charAt(0).toUpperCase()}${action.slice(1)} service(s). All if omitted`)
    .option("--json", "Output as JSON")
    .action(async (services: string[], opts: { json?: boolean }) => {
      await withDaemon(async (ipc) => {
        const params = services.length > 0 ? { names: services } : undefined;
        const res = await ipc.request(`services.${action}All`, params);
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        } else {
          const target = services.length > 0 ? services.join(", ") : "all services";
          process.stdout.write(
            `${action.charAt(0).toUpperCase()}${action.slice(1)}ed ${target}.\n`,
          );
        }
      }, globalSession());
    });
}

// --- Query ---

program
  .command("ps")
  .description("List services and their status")
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
    }, globalSession());
  });

program
  .command("ls")
  .description("List active sessions")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const sock = socketPath();
    if (!isDaemonRunning()) {
      const sessions = await listZapsSessions();
      if (sessions.length === 0) {
        process.stdout.write("No running zaps instances found.\n");
        return;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
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
    const sessions = res.result as SessionInfo[];
    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
      return;
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return;
    }
    for (const s of sessions) {
      process.stdout.write(`${s.id}  ${s.name}  ${s.projectDir}\n`);
    }
  });

program
  .command("inspect <service>")
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
    }, globalSession());
  });

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

program
  .command("logs [services...]")
  .description("Dump log buffer. -f to stream live")
  .option("-f, --follow", "Stream live logs")
  .option("--tail <n>", "Number of lines to show", "100")
  .action(async (services: string[], opts: { follow?: boolean; tail: string }) => {
    const tail = Number.parseInt(opts.tail, 10);

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
      const sub = ipcSubscribe(sock, ipc.sessionId, ["log.lines"], (event: DaemonEvent) => {
        const data = event.data as { service: string; lines: string[] };
        if (targetServices.includes(data.service)) {
          for (const line of data.lines) {
            process.stdout.write(`${formatLine(data.service, line)}\n`);
          }
        }
      });

      // Wait for ctrl+c
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          sub.close();
          resolve();
        });
      });
    }, globalSession());
  });

program
  .command("run <task>")
  .description("Run a task")
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
    }, globalSession());
  });

program
  .command("events")
  .description("Stream daemon events as ndjson")
  .option("--filter <type>", "Filter events by type (regex)")
  .action(async (opts: { filter?: string }) => {
    const sock = socketPath();

    if (!isDaemonRunning()) {
      process.stderr.write("No running daemon found.\n");
      process.exit(1);
    }

    const sessionOpt = globalSession();
    const id = await (async () => {
      if (sessionOpt) {
        const res = await ipcRequest(sock, "session.list");
        if (res.error) {
          process.stderr.write(`Error: ${res.error}\n`);
          process.exit(1);
        }
        return resolveTargetSession(res.result as SessionInfo[], sessionOpt).id;
      }
      return resolveSessionId().id;
    })();

    const filterRe = opts.filter ? new RegExp(opts.filter) : null;

    const sub = ipcSubscribe(sock, id, [], (event: DaemonEvent) => {
      if (filterRe && !filterRe.test(event.event)) {
        return;
      }
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        sub.close();
        resolve();
      });
    });
  });

program
  .command("config")
  .description("Validate and print resolved config")
  .option("--json", "Output as JSON")
  .option("--path", "Print config file path only")
  .action(async (opts: { json?: boolean; path?: boolean }) => {
    const configPath = discoverConfig(process.cwd());
    if (!configPath) {
      process.stderr.write("No config found. Run `zaps init` to create one.\n");
      process.exit(1);
    }

    if (opts.path) {
      process.stdout.write(`${configPath}\n`);
      return;
    }

    const config = await loadConfig(configPath);

    if (opts.json) {
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
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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
  });

// --- Kept As-Is ---

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

program
  .command("attach")
  .description("Attach to a running zaps session")
  .action(async () => {
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

    const sessions = res.result as SessionInfo[];
    if (sessions.length === 0) {
      process.stderr.write("No active sessions.\n");
      process.exit(1);
    }

    const targetSession = resolveTargetSession(sessions, globalSession());
    await runTui({ sessionId: targetSession.id, socketPath: sock });
  });

program
  .command("tasks")
  .description("List tasks")
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
    }, globalSession());
  });

program
  .command("ui", { hidden: true })
  .description("Run zaps TUI (internal)")
  .option("--start", "Start services before rendering TUI")
  .requiredOption("--session <id>", "Daemon session ID")
  .requiredOption("--socket <path>", "Daemon socket path")
  .action(async (opts: { start?: boolean; session: string; socket: string }) => {
    await runTui({ sessionId: opts.session, socketPath: opts.socket, autoStart: opts.start });
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

// --- CLI session routing ---

interface SessionIpc {
  readonly sessionId: string;
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

async function withDaemon<T>(fn: (ipc: SessionIpc) => Promise<T>, sessionArg?: string): Promise<T> {
  const sock = socketPath();
  if (!isDaemonRunning()) {
    if (sessionArg) {
      process.stderr.write("No running daemon found.\n");
      process.exit(1);
    }
    return withLegacyIpc(fn);
  }

  const id = await (async () => {
    if (sessionArg) {
      const res = await ipcRequest(sock, "session.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      return resolveTargetSession(res.result as SessionInfo[], sessionArg).id;
    }
    const resolved = resolveSessionId().id;
    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    if (!(res.result as { id: string }[]).some((s) => s.id === resolved)) {
      process.stderr.write("No running zaps session for this project.\n");
      process.exit(1);
    }
    return resolved;
  })();

  const ipc: SessionIpc = {
    sessionId: id,
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
    sessionId: "",
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

if (process.argv.length === 2) {
  process.argv.push("up");
}

program.parse();
