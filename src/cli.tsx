#!/usr/bin/env node
import path from "node:path";

import type { ServiceManagerDeps } from "./lib/service/manager.js";
import { program } from "commander";

import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { getEnv } from "./lib/env.js";
import { detectPorts, getDescendantPids } from "./lib/port.js";
import { createLayout } from "./lib/tmux-layout.js";
import {
  capturePane,
  currentPaneId,
  currentSession,
  killPane,
  listZapsSessions,
  panePid,
  removeEnv,
  sendCtrlC,
  sendKeys,
  setEnv,
  showEnv,
} from "./lib/tmux.js";

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
  // Compiled bun binary: argv[1] is virtual /$bunfs/ path
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return path.basename(process.execPath);
  }
  // Dev mode (tsx/node): need runtime + script
  return process.argv.slice(0, 2).join(" ");
}

program.name("zaps").version("0.1.0").description("Terminal session manager");

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

    const config = await loadConfig(configPath);

    // Must be inside tmux
    if (!getEnv("TMUX")) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    // Get current pane and session
    const originPane = await currentPaneId();
    const sessionName = await currentSession();

    // Build pane layout starting from current pane
    const paneMap = await createLayout(originPane, config.project.layout, config.project.services);

    // Serialize pane map and origin pane to tmux env
    await setEnv(sessionName, "ZAPS_PANE_MAP", JSON.stringify(paneMap));
    await setEnv(sessionName, "ZAPS_ORIGIN_PANE", originPane);

    const tuiPaneId = paneMap["@tui"];

    // Launch inner process in @tui pane
    // Shell runs command, then `exit` closes the pane after process finishes
    await sendKeys(tuiPaneId, `${resolveCommand()} ui --start; exit`);
  });

program
  .command("ui")
  .description("Run zaps TUI (called by dev command)")
  .option("--start", "Start services before rendering TUI")
  .action(async (opts: { start?: boolean }) => {
    const configPath = discoverConfig(process.cwd());
    if (!configPath) {
      process.stderr.write("No config found.\n");
      process.exit(1);
    }

    const config = await loadConfig(configPath);

    const sessionName = await currentSession();

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
    const manager = new ServiceManager(config, paneMap, deps);

    // Start services (only when launched via `zaps dev`)
    if (opts.start) {
      // eslint-disable-next-line no-void -- Fire-and-forget promise
      void manager.startAll();
    }

    // Render TUI (dynamic import to avoid TLA from ink/yoga-layout at top level)
    // Ensure yoga-wasm is loaded before Ink creates layout nodes.
    // The build plugin (scripts/build.ts) exposes __yogaReady on the Proxy default export.
    // In dev (unbundled), yoga-layout's real TLA handles init, so this resolves undefined (no-op).
    const { default: yoga } = await import("yoga-layout");
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Build plugin exposes __yogaReady on Proxy
    await (yoga as unknown as Record<string, unknown>)["__yogaReady"];

    const { render } = await import("ink");
    const { App } = await import("./components/App.js");
    const { waitUntilExit } = render(<App manager={manager} config={config} paneMap={paneMap} />, {
      patchConsole: false,
    });

    await waitUntilExit();

    // Cleanup — stopAll is idempotent, and it fires onStop hook internally
    await manager.stopAll();

    // Kill spawned panes, but preserve the origin pane and @tui pane
    const originPane = await showEnv(sessionName, "ZAPS_ORIGIN_PANE");
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
  });

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

    process.stdout.write(`Killed ${killed} pane(s).\n`);
  });

program.parse();
