#!/usr/bin/env node
import { program } from "commander";

import type { SessionInfo, SessionIpc } from "./cli/helpers.js";
import {
  CliError,
  formatTable,
  resolveCommand,
  resolveRuntime,
  resolveSessionId,
  resolveTargetSession,
  withDaemon,
} from "./cli/helpers.js";
import { isCodingAgent, resolveFormat, writeData } from "./cli/output.js";
import { DaemonClient } from "./client/daemon-client.js";
import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { ensureDaemon, runDaemon } from "./daemon/index.js";
import { isDaemonRunning, socketPath } from "./daemon/lifecycle.js";
import { sessionId } from "./daemon/session.js";
import { getEnv } from "./lib/env.js";
import { ipcRequest, ipcSubscribe } from "./lib/ipc/client.js";
import type { DaemonEvent } from "./lib/ipc/protocol.js";
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
declare const __BUILD_BRANCH__: string;

program
  .name("zaps")
  .version(
    `0.1.0 (${resolveRuntime()}) built ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "from source"}${typeof __BUILD_BRANCH__ !== "undefined" ? ` [${__BUILD_BRANCH__}]` : ""}`,
  )
  .description("Terminal session manager")
  .option("-s, --session <session>", "Target session by id/name prefix");

function globalSession(): string | undefined {
  return program.opts().session as string | undefined;
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

  await (tuiPaneId === originPane
    ? runTui({ sessionId: session.id, socketPath: sock, autoStart: true })
    : sendKeys(tuiPaneId, `${command} ui --session ${session.id} --socket ${sock} --start; exit`));
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
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
          }
          throw error;
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
      const target = (() => {
        try {
          return sessionOpt
            ? resolveTargetSession(sessions, sessionOpt)
            : sessions.find((s) => s.id === resolveSessionId().id);
        } catch (error) {
          if (error instanceof CliError) {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
          }
          throw error;
        }
      })();
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
    .option("--toon", "Output as TOON")
    .action(async (services: string[], opts: { json?: boolean; toon?: boolean }) => {
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
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
    });
}

// --- Query ---

program
  .command("ps")
  .description("List services and their status")
  .option("--json", "Output as JSON")
  .option("--toon", "Output as TOON")
  .action(async (opts: { json?: boolean; toon?: boolean }) => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("ls")
  .description("List active sessions")
  .option("--json", "Output as JSON")
  .option("--toon", "Output as TOON")
  .action(async (opts: { json?: boolean; toon?: boolean }) => {
    const format = resolveFormat(opts);
    const sock = socketPath();
    if (!isDaemonRunning()) {
      const sessions = await listZapsSessions();
      if (format !== "text") {
        writeData(sessions, format);
        return;
      }
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
    const sessions = res.result as SessionInfo[];
    if (format !== "text") {
      writeData(sessions, format);
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
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
  .option("--toon", "Output as TOON")
  .action(async (name: string, opts: { json?: boolean; toon?: boolean }) => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
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
    } catch (error) {
      if (error instanceof CliError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("run <task>")
  .description("Run a task")
  .option("--json", "Output as JSON")
  .option("--toon", "Output as TOON")
  .action(async (key: string, opts: { json?: boolean; toon?: boolean }) => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
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

    const id = await (async () => {
      try {
        const sessionOpt = globalSession();
        if (sessionOpt) {
          const res = await ipcRequest(sock, "session.list");
          if (res.error) {
            throw new CliError(`Error: ${res.error}`);
          }
          return resolveTargetSession(res.result as SessionInfo[], sessionOpt).id;
        }
        return resolveSessionId().id;
      } catch (error) {
        if (error instanceof CliError) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
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
  .option("--toon", "Output as TOON")
  .option("--path", "Print config file path only")
  .action(async (opts: { json?: boolean; toon?: boolean; path?: boolean }) => {
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
  });

program
  .command("prime-agent", { hidden: !isCodingAgent() })
  .description("Print project overview for AI agent priming")
  .action(async () => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("reload")
  .description("Reload config for running session")
  .action(async () => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
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

    try {
      const targetSession = resolveTargetSession(sessions, globalSession());
      await runTui({ sessionId: targetSession.id, socketPath: sock });
    } catch (error) {
      if (error instanceof CliError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("tasks")
  .description("List tasks")
  .option("--json", "Output as JSON")
  .option("--toon", "Output as TOON")
  .action(async (opts: { json?: boolean; toon?: boolean }) => {
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
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
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
  .option("--toon", "Output as TOON")
  .action(async (opts: { json?: boolean; toon?: boolean }) => {
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
  });

daemonCmd
  .command("ping")
  .description("Check if daemon is responsive")
  .action(async () => {
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
  });

program
  .command("mcp")
  .description("Start MCP server for AI tool integration")
  .option("-s, --session <id>", "Target session (auto-detected from CWD)")
  .action(async (opts: { session?: string }) => {
    const sock = socketPath();
    let targetSessionId = "";
    try {
      const res = await ipcRequest(sock, "session.list");
      if (!res.error) {
        // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
        const sessions = res.result as SessionInfo[];
        if (sessions.length > 0) {
          targetSessionId = resolveTargetSession(sessions, opts.session).id;
        }
      }
    } catch {
      // Daemon not running — MCP server will report errors per-tool call
    }
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer(sock, targetSessionId);
  });

if (process.argv.length === 2) {
  process.argv.push("up");
}

program.parse();
