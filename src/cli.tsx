#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import type { ServiceManagerDeps } from "./lib/service/manager.js";
import { program } from "commander";

import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { getEnv } from "./lib/env.js";
import { ipcRequest, ipcStream } from "./lib/ipc/client.js";
import { IpcServer } from "./lib/ipc/server.js";
import { detectPorts, getDescendantPids } from "./lib/port.js";
import { createLayout } from "./lib/tmux-layout.js";
import {
  capturePane,
  currentPaneId,
  currentSession,
  getWindowName,
  getWindowOption,
  killPane,
  listZapsSessions,
  panePid,
  removeEnv,
  renameWindow,
  selectPane,
  sendCtrlC,
  sendKeys,
  setEnv,
  setWindowOption,
  showEnv,
} from "./lib/tmux.js";

declare const __BUILD_TIME__: string;

function isPaneMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const v of Object.values(value)) {
    if (typeof v !== "string") {
      return false;
    }
  }
  return true;
}

function resolveCommand(): string {
  const zapsCommand = getEnv("ZAPS_COMMAND");
  if (zapsCommand) {
    return zapsCommand;
  }
  // Compiled bun binary: argv[1] is virtual /$bunfs/ path
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return path.basename(process.execPath);
  }
  // Dev mode (tsx/node): need runtime + script
  return process.argv.slice(0, 2).join(" ");
}

function resolveRuntime(): string {
  const env = getEnv("ZAPS_RUNTIME");
  if (env) {
    return env;
  }
  // Compiled bun binary invoked directly (no bash wrapper)
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

/**
 * Build real ServiceManagerDeps from the actual tmux/port modules.
 */
function buildDeps(): ServiceManagerDeps {
  return {
    sendKeys,
    sendCtrlC,
    panePid,
    detectPorts,
    capturePane,
    getDescendantPids,
    renameWindow,
    getWindowName,
    getWindowOption,
    setWindowOption,
  };
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
    const config = await loadConfig(configPath, invokeDir);

    // Must be inside tmux
    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    // Get current pane and session
    const originPane = await currentPaneId();
    const sessionName = await currentSession();

    // Build pane layout starting from current pane
    const { paneMap, focusPane } = await createLayout(
      originPane,
      config.project.layout,
      config.project.services,
    );

    // Focus the designated pane (defaults to @tui)
    await selectPane(focusPane);

    // Serialize pane map, origin pane, and invoke dir to tmux env
    await setEnv(sessionName, "ZAPS_PANE_MAP", JSON.stringify(paneMap));
    await setEnv(sessionName, "ZAPS_ORIGIN_PANE", originPane);
    await setEnv(sessionName, "ZAPS_INVOKE_DIR", invokeDir);

    const tuiPaneId = paneMap["@tui"];

    // Launch inner process in @tui pane
    if (tuiPaneId === originPane) {
      // Same pane: become the inner process directly — no subprocess, no sendKeys
      await runTui({ start: true });
    } else {
      // Different pane: send command via tmux IPC
      await sendKeys(tuiPaneId, `${resolveCommand()} ui --start; exit`);
    }
  });

async function runTui(opts: { start?: boolean }): Promise<void> {
  const configPath = discoverConfig(process.cwd());
  if (!configPath) {
    process.stderr.write("No config found.\n");
    process.exit(1);
  }

  const sessionName = await currentSession();

  // Read invoke dir from tmux environment (set by `zaps dev`)
  const invokeDir = await showEnv(sessionName, "ZAPS_INVOKE_DIR");

  const config = await loadConfig(configPath, invokeDir || process.cwd());

  // Read pane map from tmux environment
  const paneMapRaw = await showEnv(sessionName, "ZAPS_PANE_MAP");
  if (!paneMapRaw) {
    process.stderr.write("ZAPS_PANE_MAP not set. Must run via `zaps dev`.\n");
    process.exit(1);
  }

  const parsed: unknown = JSON.parse(paneMapRaw);
  if (!isPaneMap(parsed)) {
    process.stderr.write("ZAPS_PANE_MAP is not a valid pane map.\n");
    process.exit(1);
  }
  const paneMap = parsed;
  const deps = buildDeps();
  const { ServiceManager } = await import("./lib/service/manager.js");
  const manager = new ServiceManager(config, paneMap, deps, sessionName);

  // Start IPC server
  const socketPath = `${os.tmpdir()}/zaps-${sessionName.replaceAll("/", "-")}.sock`;
  const ipcServer = new IpcServer(socketPath, manager, config);
  await ipcServer.start();
  await setEnv(sessionName, "ZAPS_IPC_SOCKET", socketPath);

  // Render TUI (dynamic import to avoid TLA from ink/yoga-layout at top level)
  // Ensure yoga-wasm is loaded before Ink creates layout nodes.
  // The build plugin (scripts/build.ts) exposes __yogaReady on the Proxy default export.
  // In dev (unbundled), yoga-layout's real TLA handles init, so this resolves undefined (no-op).
  const { default: yoga } = await import("yoga-layout");
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Build plugin exposes __yogaReady on Proxy
  await (yoga as unknown as Record<string, unknown>)["__yogaReady"];

  // Enter alternate screen buffer (like vim/htop) so TUI output doesn't linger after exit
  process.stdout.write("\x1b[?1049h");

  // Show ANSI splash while Ink loads — uses tmux pane dimensions for correct centering
  if (opts.start) {
    const { renderSplash } = await import("./components/logo.js");
    const { listPanes } = await import("./lib/tmux.js");
    const panes = await listPanes(sessionName);
    const tuiPane = panes.find((p) => p.id === paneMap["@tui"]);
    if (tuiPane) {
      renderSplash({ cols: tuiPane.width, rows: tuiPane.height });
    } else {
      renderSplash();
    }
  }

  const { render } = await import("ink");
  const { App } = await import("./components/App.js");

  const { waitUntilExit } = render(
    <App manager={manager} config={config} paneMap={paneMap} autoStart={Boolean(opts.start)} />,
    {
      patchConsole: false,
    },
  );

  await waitUntilExit();

  // Leave alternate screen buffer — restores original terminal content
  process.stdout.write("\x1b[?1049l");

  // Read origin pane before cleaning env (needed for pane-killing loop)
  const originPane = await showEnv(sessionName, "ZAPS_ORIGIN_PANE");

  // Stop IPC server and remove env vars early so `zaps sessions` no longer sees this as alive
  ipcServer.stop();
  await removeEnv(sessionName, "ZAPS_IPC_SOCKET").catch(() => {});
  await removeEnv(sessionName, "ZAPS_PANE_MAP").catch(() => {});
  await removeEnv(sessionName, "ZAPS_ORIGIN_PANE").catch(() => {});
  await removeEnv(sessionName, "ZAPS_INVOKE_DIR").catch(() => {});

  // Cleanup — stopAll is idempotent, and it fires onStop hook internally
  await manager.stopAll();
  const tuiPaneId = paneMap["@tui"];
  for (const paneId of Object.values(paneMap)) {
    if (paneId !== originPane && paneId !== tuiPaneId) {
      // eslint-disable-next-line no-await-in-loop -- Sequential tmux operations
      await killPane(paneId).catch(() => {
        /* Pane may already be gone */
      });
    }
  }
  // TUI pane closes automatically on process exit (launched via exec)
}

program
  .command("ui")
  .description("Run zaps TUI (called by dev command)")
  .option("--start", "Start services before rendering TUI")
  .action(runTui);

program
  .command("sessions")
  .description("List running zaps instances")
  .action(async () => {
    const sessions = await listZapsSessions();
    if (sessions.length === 0) {
      process.stdout.write("No running zaps instances found.\n");
      return;
    }
    for (const { session, panes } of sessions) {
      process.stdout.write(`${session} (${panes} panes)\n`);
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

async function withIpc<T>(fn: (socketPath: string) => Promise<T>): Promise<T> {
  if (!getEnv("TMUX")) {
    process.stderr.write("Must be inside a tmux session.\n");
    process.exit(1);
  }

  const sessionName = await currentSession();
  const socketPath = await showEnv(sessionName, "ZAPS_IPC_SOCKET");
  if (!socketPath) {
    process.stderr.write("No running zaps instance found in this session.\n");
    process.exit(1);
  }

  return fn(socketPath);
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = rows[0].length;
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
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
    await withIpc(async (sock) => {
      const res = await ipcRequest(sock, "services.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        return;
      }
      const statuses = res.result as Array<{
        name: string;
        state: string;
        ports: number[];
        url?: string;
      }>;
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
    await withIpc(async (sock) => {
      const res = await ipcRequest(sock, "tasks.list");
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        return;
      }
      const tasks = res.result as Array<{ key: string; name: string; description: string | null }>;
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
    await withIpc(async (sock) => {
      const res = await ipcStream(
        sock,
        "tasks.run",
        { key },
        (event, data) => {
          if (!opts.json && event === "line") {
            process.stdout.write(`${data as string}\n`);
          }
        },
      );
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
    await withIpc(async (sock) => {
      const res = await ipcRequest(sock, "services.details", { name });
      if (res.error) {
        process.stderr.write(`Error: ${res.error}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
        return;
      }
      const d = res.result as Record<string, unknown>;
      for (const [k, v] of Object.entries(d)) {
        const val = Array.isArray(v) ? v.join(", ") || "-" : String(v ?? "-");
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
      await withIpc(async (sock) => {
        const res = await ipcRequest(sock, `services.${action}`, { name });
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
  .description("Stop all services and kill spawned panes")
  .action(async () => {
    // Must be inside tmux
    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    const sessionName = await currentSession();

    // Read pane map from tmux env
    const raw = await showEnv(sessionName, "ZAPS_PANE_MAP");
    if (!raw) {
      process.stderr.write("No active zaps panes found in this session.\n");
      process.exit(1);
    }

    const parsedDown: unknown = JSON.parse(raw);
    if (!isPaneMap(parsedDown)) {
      process.stderr.write("ZAPS_PANE_MAP is not a valid pane map.\n");
      process.exit(1);
    }
    const paneMap = parsedDown;
    const originPane = await currentPaneId();

    let killed = 0;
    for (const paneId of Object.values(paneMap)) {
      if (paneId !== originPane) {
        // eslint-disable-next-line no-await-in-loop -- Sequential tmux operations
        await killPane(paneId).catch(() => {
          /* Pane may already be gone */
        });
        killed += 1;
      }
    }

    await removeEnv(sessionName, "ZAPS_PANE_MAP").catch(() => {
      /* Session may already be gone */
    });
    await removeEnv(sessionName, "ZAPS_ORIGIN_PANE").catch(() => {
      /* Session may already be gone */
    });
    await removeEnv(sessionName, "ZAPS_INVOKE_DIR").catch(() => {
      /* Session may already be gone */
    });

    process.stdout.write(`Killed ${killed} pane(s).\n`);
  });

program.parse();
